const TOLERANCE_SECONDS = 300;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

function hex(buffer) {
  return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(function (item) {
    const kv = item.split('=');
    parts[kv[0]] = kv[1];
  });
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const age = Math.abs((Date.now() / 1000) - Number(timestamp));
  if (age > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + payload));
  const expected = hex(sigBuffer);

  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ error: 'Unhandled exception', message: e.message, stack: e.stack }, 500);
  }
}

async function handle(context) {
  const { request, env } = context;

  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature');
  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid signature' }, 400);

  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { return json({ error: 'Invalid JSON' }, 400); }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  const purchaseId = session.metadata && session.metadata.purchase_id;
  if (!purchaseId) return json({ error: 'Missing purchase_id in session metadata' }, 400);

  const email = session.customer_details && session.customer_details.email;

  const purchasePatch = {
    status: 'paid',
    paid_at: new Date().toISOString(),
    stripe_payment_id: session.payment_intent || session.id
  };
  if (email) purchasePatch.email = email;

  const purRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(purchasePatch)
  });
  if (!purRes.ok) {
    const detail = await purRes.text();
    return json({ error: 'Failed to mark purchase paid', detail: detail }, 502);
  }

  const slotsRes = await fetch(env.SUPABASE_URL + '/rest/v1/slots?purchase_id=eq.' + purchaseId, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ is_sold: true })
  });
  if (!slotsRes.ok) {
    const detail = await slotsRes.text();
    return json({ error: 'Failed to mark slots sold', detail: detail }, 502);
  }

  return json({ received: true });
}
