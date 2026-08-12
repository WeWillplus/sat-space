import { json, isBlockedOrigin, isRateLimited, sweepExpired, purchaseToken } from '../../lib/api-guards.js';

const SATS_PER_SLOT = 140000;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_CELLS = 144;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mime: m[1], base64: m[2] } : null;
}

// Returns null instead of throwing. atob() rejects malformed base64 with an
// exception, and by the time this runs the slots are already claimed, so an
// uncaught throw would strand them behind a generic 500 with no cleanup.
function base64ToBytes(base64) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (e) {
    return null;
  }
}

// Checks the file really is what it says it is, by reading the first few bytes
// rather than trusting the type the browser announced. Anyone can claim
// image/png; only a real PNG starts with the PNG signature.
function looksLike(mime, b) {
  if (mime === 'image/png') {
    return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
           b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
  }
  if (mime === 'image/jpeg') {
    return b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  }
  if (mime === 'image/webp') {
    return b.length > 12 &&
           b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
           b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  }
  return false;
}

async function releaseSlots(env, purchaseId) {
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/slots?purchase_id=eq.' + purchaseId, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ purchase_id: null })
    });
  } catch (e) { /* best effort cleanup */ }
}

async function deletePurchase(env, purchaseId) {
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
    });
  } catch (e) { /* best effort cleanup */ }
}

async function abort(env, purchaseId, errorMsg, status) {
  await releaseSlots(env, purchaseId);
  await deletePurchase(env, purchaseId);
  return json({ error: errorMsg }, status || 400);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (isBlockedOrigin(request)) return json({ error: 'Request did not come from Sat Space' }, 403);

  if (await isRateLimited(env, request, 'reserve')) {
    return json({ error: 'Too many reservation attempts, wait a few minutes and try again' }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

  // Hand back any slots held by reservations nobody paid for, before we check
  // what is still free. Otherwise an abandoned checkout blocks this buyer.
  await sweepExpired(env);

  const rawCells = Array.isArray(body.cells) ? body.cells : null;
  if (!rawCells || rawCells.length === 0) return json({ error: 'No slots selected' }, 400);
  if (rawCells.length > MAX_CELLS) return json({ error: 'Too many slots selected' }, 400);

  for (const c of rawCells) {
    if (typeof c.col !== 'number' || typeof c.row !== 'number' ||
        !Number.isInteger(c.col) || !Number.isInteger(c.row) ||
        c.col < 0 || c.col > 17 || c.row < 0 || c.row > 7) {
      return json({ error: 'Invalid slot coordinates' }, 400);
    }
  }

  const seen = new Set();
  const cells = [];
  for (const c of rawCells) {
    const key = c.col + ',' + c.row;
    if (!seen.has(key)) { seen.add(key); cells.push({ col: c.col, row: c.row }); }
  }

  const orFilter = cells.map(function (c) { return 'and(col.eq.' + c.col + ',row.eq.' + c.row + ')'; }).join(',');
  const slotCount = cells.length;
  const satsAmount = slotCount * SATS_PER_SLOT;

  const artZoom = typeof body.artZoom === 'number' ? body.artZoom : 1;
  const artOffsetX = typeof body.artOffsetX === 'number' ? body.artOffsetX : 0;
  const artOffsetY = typeof body.artOffsetY === 'number' ? body.artOffsetY : 0;

  // Step 1: create the purchase row first so we have an id to claim slots with.
  const insertRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify([{
      slot_count: slotCount, sats_amount: satsAmount, status: 'pending',
      art_zoom: artZoom, art_offset_x: artOffsetX, art_offset_y: artOffsetY
    }])
  });
  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return json({ error: 'Failed to create purchase', detail: detail }, 502);
  }
  const purchase = (await insertRes.json())[0];

  // Step 2: atomically claim only the slots that are still free and unclaimed.
  // This single UPDATE is what actually prevents two buyers racing for the
  // same slot, either it claims all requested cells or none of them, decided
  // by the database in one indivisible step, not by two separate round-trips.
  const claimRes = await fetch(
    env.SUPABASE_URL + '/rest/v1/slots?or=(' + orFilter + ')&is_sold=eq.false&purchase_id=is.null',
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ purchase_id: purchase.id })
    }
  );
  if (!claimRes.ok) {
    const detail = await claimRes.text();
    await deletePurchase(env, purchase.id);
    return json({ error: 'Failed to claim slots', detail: detail }, 502);
  }
  const claimed = await claimRes.json();

  if (claimed.length !== cells.length) {
    return abort(env, purchase.id, 'One or more selected slots were just taken by someone else', 409);
  }

  // Step 3: only now, with the slots safely and exclusively claimed, upload artwork.
  if (body.artwork) {
    const parsed = parseDataUrl(body.artwork);
    if (!parsed) return abort(env, purchase.id, 'Invalid artwork data', 400);

    const ext = EXT_BY_MIME[parsed.mime];
    if (!ext) return abort(env, purchase.id, 'Unsupported artwork type, use PNG, JPEG, or WEBP', 400);

    // Check the size before decoding, not after. Base64 is about a third
    // larger than the bytes it encodes, so this rejects an oversized upload
    // without first allocating it in memory.
    if (parsed.base64.length > Math.ceil(MAX_ARTWORK_BYTES * 4 / 3) + 1024) {
      return abort(env, purchase.id, 'Artwork exceeds 5MB limit', 400);
    }

    const bytes = base64ToBytes(parsed.base64);
    if (!bytes) return abort(env, purchase.id, 'Artwork could not be read, try uploading it again', 400);
    if (bytes.length > MAX_ARTWORK_BYTES) return abort(env, purchase.id, 'Artwork exceeds 5MB limit', 400);
    if (!looksLike(parsed.mime, bytes)) {
      return abort(env, purchase.id, 'That file is not a valid PNG, JPEG, or WEBP image', 400);
    }

    const imagePath = 'purchase-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
    const uploadRes = await fetch(env.SUPABASE_URL + '/storage/v1/object/artwork/' + imagePath, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': parsed.mime
      },
      body: bytes
    });
    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      await releaseSlots(env, purchase.id);
      await deletePurchase(env, purchase.id);
      return json({ error: 'Failed to upload artwork', detail: detail }, 502);
    }

    const imgPatchRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchase.id, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ image_path: imagePath })
    });
    if (!imgPatchRes.ok) {
      const detail = await imgPatchRes.text();
      return json({ error: 'Slots reserved, but failed to save artwork reference', detail: detail }, 502);
    }
  }

  // The token goes back to this buyer only, and /api/checkout requires it.
  // It is what stops someone walking purchase ids and starting checkouts on
  // reservations that are not theirs.
  const token = await purchaseToken(env, purchase.id);

  return json({ purchaseId: purchase.id, slotCount: slotCount, satsAmount: satsAmount, token: token });
}
