function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

function isValidId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

  if (!isValidId(body.purchaseId)) return json({ error: 'Missing or invalid purchaseId' }, 400);
  const purchaseId = Number(body.purchaseId);

  const action = body.action;
  if (action !== 'approve' && action !== 'reject') return json({ error: 'action must be "approve" or "reject"' }, 400);
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // Only transitions purchases still sitting at "paid", prevents double-processing
  // the same purchase from two open tabs or a double click.
  const patchRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId + '&status=eq.paid', {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      status: newStatus,
      approved_at: newStatus === 'approved' ? new Date().toISOString() : null
    })
  });
  if (!patchRes.ok) {
    const detail = await patchRes.text();
    return json({ error: 'Failed to update purchase', detail: detail }, 502);
  }

  const rows = await patchRes.json();
  if (rows.length === 0) return json({ error: 'Purchase not found or already reviewed' }, 409);

  if (newStatus === 'rejected') {
    // Free the slots back up for someone else to buy. Refunding the buyer
    // and telling them what happened is handled manually by Dustin, on
    // purpose, since rejections are expected to be rare enough that a
    // human judgment call beats automating it.
    const releaseRes = await fetch(env.SUPABASE_URL + '/rest/v1/slots?purchase_id=eq.' + purchaseId, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ is_sold: false, purchase_id: null })
    });
    if (!releaseRes.ok) {
      const detail = await releaseRes.text();
      return json({ error: 'Purchase rejected, but failed to release the slots', detail: detail }, 502);
    }
  }

  return json({ purchaseId: purchaseId, status: newStatus });
}
