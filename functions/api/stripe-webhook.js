const TOLERANCE_SECONDS = 300;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

function isValidId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

function hex(buffer) {
  return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  // Stripe sends one v1 signature per active signing secret, so during a
  // secret rotation the header carries several. Keeping only the last one
  // would make verification fail at exactly the moment secrets are being
  // rotated, so collect them all and accept a match against any.
  let timestamp = null;
  const signatures = [];
  sigHeader.split(',').forEach(function (item) {
    const idx = item.indexOf('=');
    if (idx < 0) return;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  });
  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs((Date.now() / 1000) - Number(timestamp));
  if (age > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + payload));
  const expected = hex(sigBuffer);

  return signatures.some(function (candidate) {
    if (expected.length !== candidate.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    return diff === 0;
  });
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
  const rawPurchaseId = session.metadata && session.metadata.purchase_id;
  if (!isValidId(rawPurchaseId)) return json({ error: 'Missing or invalid purchase_id in session metadata' }, 400);
  const purchaseId = Number(rawPurchaseId);

  const email = session.customer_details && session.customer_details.email;

  // Check the current state before writing anything. Two things make this
  // necessary: Stripe retries a webhook until it gets a 200, so this can be
  // called more than once for the same payment, and a payment can in theory
  // land against a reservation that already expired, which needs a human.
  const lookupRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId + '&select=id,status', {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!lookupRes.ok) {
    const detail = await lookupRes.text();
    return json({ error: 'Failed to look up purchase', detail: detail }, 502);
  }
  const existing = (await lookupRes.json())[0];
  if (!existing) return json({ error: 'Purchase not found' }, 404);

  // Already dealt with. Return 200 so Stripe stops retrying.
  if (existing.status !== 'pending' && existing.status !== 'expired') {
    return json({ received: true, alreadyProcessed: true, status: existing.status });
  }

  const wasExpired = existing.status === 'expired';

  const purchasePatch = {
    status: 'paid',
    paid_at: new Date().toISOString(),
    stripe_payment_id: session.payment_intent || session.id
  };
  if (email) purchasePatch.email = email;

  const purRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId + '&status=in.(pending,expired)', {
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

  // The slot update above matched nothing in this case, because expiring the
  // reservation already handed those slots back. The money is real and
  // recorded, but there is nothing to show for it, so this needs Dustin.
  if (wasExpired) {
    await notifyExpiredPayment(env, purchaseId, email);
    return json({ received: true, expiredReservation: true });
  }

  await notifyDiscord(env, purchaseId, email);

  return json({ received: true });
}

async function notifyExpiredPayment(env, purchaseId, email) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const lines = [
    '@here PAYMENT AGAINST AN EXPIRED RESERVATION, needs manual action.',
    'Purchase #' + purchaseId + ' was paid after its slots had already been released.',
    'The payment is recorded, but no slots are held for this buyer.',
    email ? 'Buyer: ' + email : 'Buyer email unknown.',
    'Either refund them in Stripe, or reassign slots by hand if any are still free.'
  ];
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') })
    });
  } catch (e) { /* best effort, must never fail the payment confirmation */ }
}

async function notifyDiscord(env, purchaseId, email) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  let info = null;
  try {
    const infoRes = await fetch(env.SUPABASE_URL + '/rest/v1/purchases?id=eq.' + purchaseId + '&select=slot_count,sats_amount,eur_amount', {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (infoRes.ok) {
      const rows = await infoRes.json();
      info = rows[0];
    }
  } catch (e) { /* notification is best-effort, missing details shouldn't block it */ }

  const lines = ['New Sat Space purchase, ready for review.', 'Purchase #' + purchaseId];
  if (info) {
    lines.push(info.slot_count + (info.slot_count === 1 ? ' slot' : ' slots') + ' | ' + info.sats_amount + ' sats | EUR ' + info.eur_amount);
  }
  if (email) lines.push('Buyer: ' + email);
  lines.push('Approve it in Supabase, purchases table.');

  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') })
    });
  } catch (e) { /* notification is best-effort, must never fail the payment confirmation */ }
}
