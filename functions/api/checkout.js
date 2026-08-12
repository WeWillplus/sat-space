import { json, isBlockedOrigin, isRateLimited, STRIPE_SESSION_SECONDS, purchaseToken, tokensMatch } from '../../lib/api-guards.js';

function isValidId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (isBlockedOrigin(request)) return json({ error: 'Request did not come from Sat Space' }, 403);

  if (await isRateLimited(env, request, 'checkout')) {
    return json({ error: 'Too many checkout attempts, wait a few minutes and try again' }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'Invalid request body' }, 400); }

  if (!isValidId(body.purchaseId)) return json({ error: 'Missing or invalid purchaseId' }, 400);
  const purchaseId = Number(body.purchaseId);

  // Only the browser that made this reservation was given the token, so this
  // is what proves the caller owns it. Purchase ids are sequential and easy to
  // guess; without this, anyone could walk them and start checkouts on other
  // people's pending reservations, re-locking their rate and leaving orphaned
  // Stripe sessions behind.
  if (!tokensMatch(body.token, await purchaseToken(env, purchaseId))) {
    return json({ error: 'This reservation does not belong to you' }, 403);
  }

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
  // Kill the payment link at the same time the reservation runs out, so a
  // stale link can never be paid for slots that have gone back on sale.
  // Stripe rejects anything under 30 minutes, which is why the reservation
  // window is longer once someone has reached this point.
  params.append('expires_at', String(Math.floor(Date.now() / 1000) + STRIPE_SESSION_SECONDS));
  // Austrian invoices up to 400 euro can leave out the buyer's name and
  // address (Kleinbetragsrechnung). Above that, both are required. Slots are
  // priced in sats, so the euro total moves with Bitcoin and the slot count
  // where an order crosses 400 euro moves with it: around six slots at 55k,
  // about three at 100k. Since that cannot be predicted at checkout time, the
  // address is collected on every purchase rather than only on large ones.
  params.append('billing_address_collection', 'required');

  // Optional for the buyer. Consumers skip it; a company can enter its UID and
  // have it appear on the invoice, which businesses expect even where no VAT
  // is charged.
  params.append('tax_id_collection[enabled]', 'true');

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
