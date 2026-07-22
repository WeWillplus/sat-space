function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

  const purchaseId = body.purchaseId;
  if (!purchaseId) return json({ error: 'Missing purchaseId' }, 400);

  const purRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId + '&select=id,slot_count,sats_amount,status', {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!purRes.ok) { const detail = await purRes.text(); return json({ error: 'Failed to look up purchase', detail: detail }, 502); }
  const purRows = await purRes.json();
  const purchase = purRows[0];
  if (!purchase) return json({ error: 'Purchase not found' }, 404);
  if (purchase.status !== 'pending') return json({ error: 'Purchase is not pending' }, 409);

  const rateUrl = new URL('/api/rate', request.url).toString();
  const rateRes = await fetch(rateUrl);
  if (!rateRes.ok) return json({ error: 'Failed to fetch live rate' }, 502);
  const rateData = await rateRes.json();
  if (!rateData.rate) return json({ error: 'Live rate unavailable' }, 502);
  const rate = rateData.rate;

  const eurAmount = Math.round((purchase.sats_amount / 1e8 * rate) * 100) / 100;
  const unitAmountCents = Math.round(eurAmount * 100);

  const patchRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ eur_amount: eurAmount, btc_eur_rate: rate })
  });
  if (!patchRes.ok) { const detail = await patchRes.text(); return json({ error: 'Failed to lock in rate', detail: detail }, 502); }

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('line_items[0][price_data][currency]', 'eur');
  params.append('line_items[0][price_data][product_data][name]', 'Sat Space, ' + purchase.slot_count + (purchase.slot_count === 1 ? ' slot' : ' slots'));
  params.append('line_items[0][price_data][unit_amount]', String(unitAmountCents));
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', origin + '/success.html?purchase_id=' + purchaseId);
  params.append('cancel_url', origin + '/index.html?canceled=1');
  params.append('metadata[purchase_id]', String(purchaseId));
  params.append('invoice_creation[enabled]', 'true');
  params.append('invoice_creation[invoice_data][footer]', 'No VAT charged. Small business exemption under Austrian VAT law (Kleinunternehmerregelung, section 6 para 1 no 27 UStG).');

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  if (!stripeRes.ok) { const detail = await stripeRes.text(); return json({ error: 'Failed to create Stripe checkout session', detail: detail }, 502); }

  const session = await stripeRes.json();
  return json({ checkoutUrl: session.url });
}
