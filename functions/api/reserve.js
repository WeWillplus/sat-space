const SATS_PER_SLOT = 140000;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_CELLS = 144;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mime: m[1], base64: m[2] } : null;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

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

    const bytes = base64ToBytes(parsed.base64);
    if (bytes.length > MAX_ARTWORK_BYTES) return abort(env, purchase.id, 'Artwork exceeds 5MB limit', 400);

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

  return json({ purchaseId: purchase.id, slotCount: slotCount, satsAmount: satsAmount });
}
