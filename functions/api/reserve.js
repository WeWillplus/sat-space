const SATS_PER_SLOT = 140000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

  const cells = Array.isArray(body.cells) ? body.cells : null;
  if (!cells || cells.length === 0) return json({ error: 'No slots selected' }, 400);

  for (const c of cells) {
    if (typeof c.col !== 'number' || typeof c.row !== 'number' ||
        c.col < 0 || c.col > 17 || c.row < 0 || c.row > 7) {
      return json({ error: 'Invalid slot coordinates' }, 400);
    }
  }

  const orFilter = cells.map(function (c) { return 'and(col.eq.' + c.col + ',row.eq.' + c.row + ')'; }).join(',');
  const checkRes = await fetch(env.SUPABASE_URL + '/rest/v1/slots?select=col,row,is_sold&or=(' + orFilter + ')', {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!checkRes.ok) {
    const detail = await checkRes.text();
    return json({ error: 'Failed to verify slot availability', status: checkRes.status, detail: detail }, 502);
  }

  const existing = await checkRes.json();
  if (existing.length !== cells.length) return json({ error: 'One or more selected slots do not exist' }, 400);
  if (existing.some(function (s) { return s.is_sold; })) {
    return json({ error: 'One or more selected slots are already sold' }, 409);
  }

  const slotCount = cells.length;
  const satsAmount = slotCount * SATS_PER_SLOT;

  const insertRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify([{ slot_count: slotCount, sats_amount: satsAmount, status: 'pending' }])
  });
  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return json({ error: 'Failed to create purchase', detail: detail }, 502);
  }

  const rows = await insertRes.json();
  const purchase = rows[0];
  return json({ purchaseId: purchase.id, slotCount: slotCount, satsAmount: satsAmount });
}
