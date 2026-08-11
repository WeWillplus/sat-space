// Shared guards for the public write endpoints, /api/reserve and /api/checkout.
//
// Why this file lives in /lib and not in /functions: every file inside
// /functions becomes a real URL on the site. This is a helper, not an
// endpoint, so it stays out of there and gets imported instead.

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

// A reservation that never made it to Stripe. Nothing can be paid, so this is
// free to expire fast.
export const RESERVE_EXPIRY_MINUTES = 15;

// How long the Stripe payment page stays alive. Stripe will not accept
// anything under 30 minutes, so this is their floor plus a minute of slack.
export const STRIPE_SESSION_SECONDS = 30 * 60 + 60;

// When we free slots for someone who did reach Stripe. Deliberately later than
// the session above, so the payment link is always dead before the slots move.
// Getting this backwards would let someone pay for slots we already resold.
export const CHECKOUT_EXPIRY_MINUTES = 32;

// ---------------------------------------------------------------------------
// Rate limits, per IP per window
// ---------------------------------------------------------------------------

export const LIMITS = {
  reserve: { max: 6, windowMinutes: 10 },
  checkout: { max: 10, windowMinutes: 10 }
};

// How long a rate-limit record is kept before the sweep bins it.
const RATE_LIMIT_RETENTION_MINUTES = 60;

// ---------------------------------------------------------------------------
// Origins allowed to POST to the write endpoints
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = [
  'https://satspace.wewillplus.com',
  'https://sat-space.pages.dev'
];

// Cloudflare preview deploys land on <something>.sat-space.pages.dev. The
// leading dot matters: without it, "evil-sat-space.pages.dev" would match.
const PREVIEW_SUFFIX = '.sat-space.pages.dev';

export function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

// Blocks another website from firing requests through a visitor's browser.
//
// Browsers attach an Origin header to every POST they send, so a request that
// arrives claiming to be from somewhere else really is from somewhere else,
// and gets turned away.
//
// A request with no Origin at all is let through on purpose. Only a script can
// do that, and a script can equally well send a forged Origin, so refusing
// them buys almost nothing. What it would cost is real: a privacy extension
// that strips the header would leave that buyer unable to pay, staring at an
// error blaming them for it. Scripts are the rate limiter's problem, not this
// function's.
export function isBlockedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) > -1) return false;
  try {
    const url = new URL(origin);
    return !(url.protocol === 'https:' && url.hostname.endsWith(PREVIEW_SUFFIX));
  } catch (e) {
    return true;
  }
}

function sbHeaders(env, extra) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY
  };
  if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  return headers;
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

// We never store the visitor's IP address itself, only an unreadable
// fingerprint of it. Same IP always produces the same fingerprint, so counting
// still works, but the stored value cannot be turned back into an address.
// RATE_LIMIT_SALT is what makes that one-way in practice rather than in theory.
async function fingerprint(env, ip) {
  const salt = env.RATE_LIMIT_SALT || 'sat-space-unsalted';
  const bytes = new TextEncoder().encode(salt + '|' + ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.prototype.map.call(new Uint8Array(digest), function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

// Returns true when the caller has gone over the limit.
//
// Every failure path here returns false, meaning "let them through". A broken
// rate limiter must never be the reason a real buyer cannot pay.
export async function isRateLimited(env, request, bucket) {
  const limit = LIMITS[bucket];
  if (!limit) return false;

  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;

  try {
    const client = await fingerprint(env, ip);
    const since = minutesAgo(limit.windowMinutes);

    const countRes = await fetch(
      env.SUPABASE_URL + '/rest/v1/rate_limits' +
        '?bucket=eq.' + bucket +
        '&client_hash=eq.' + client +
        '&created_at=gt.' + encodeURIComponent(since) +
        '&select=id&limit=' + limit.max,
      { headers: sbHeaders(env) }
    );
    if (!countRes.ok) return false;

    const rows = await countRes.json();
    if (rows.length >= limit.max) return true;

    await fetch(env.SUPABASE_URL + '/rest/v1/rate_limits', {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify([{ bucket: bucket, client_hash: client }])
    });

    return false;
  } catch (e) {
    return false;
  }
}

async function findExpired(env, stage, cutoffMinutes) {
  // stage "reserve" means checkout was never started, which we can tell
  // because /api/checkout is the only thing that ever writes btc_eur_rate.
  const rateFilter = stage === 'reserve' ? 'btc_eur_rate=is.null' : 'btc_eur_rate=not.is.null';
  const res = await fetch(
    env.SUPABASE_URL + '/rest/v1/purchases' +
      '?status=eq.pending' +
      '&' + rateFilter +
      '&created_at=lt.' + encodeURIComponent(minutesAgo(cutoffMinutes)) +
      '&select=id,image_path',
    { headers: sbHeaders(env) }
  );
  if (!res.ok) return [];
  return await res.json();
}

// Releases the slots held by reservations nobody ever paid for.
//
// Without this, closing the tab at the payment page locks those slots for the
// rest of the campaign while the grid still shows them as available, and the
// next buyer gets told the slots were "just taken by someone else" forever.
//
// Runs opportunistically off the back of normal traffic rather than on a timer,
// so there is no cron job to set up or forget about.
export async function sweepExpired(env) {
  try {
    const stale = (await findExpired(env, 'reserve', RESERVE_EXPIRY_MINUTES))
      .concat(await findExpired(env, 'checkout', CHECKOUT_EXPIRY_MINUTES));
    if (stale.length === 0) {
      await cleanRateLimits(env);
      return;
    }

    const ids = stale.map(function (p) { return p.id; }).join(',');

    // The status=eq.pending filter repeats on purpose. Between the read above
    // and this write, Stripe's webhook may have marked one of these paid, and
    // that payment must win.
    const patchRes = await fetch(
      env.SUPABASE_URL + '/rest/v1/purchases?id=in.(' + ids + ')&status=eq.pending',
      {
        method: 'PATCH',
        headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'expired' })
      }
    );
    if (!patchRes.ok) return;

    const expired = await patchRes.json();
    if (expired.length === 0) return;

    const expiredIds = expired.map(function (p) { return p.id; }).join(',');
    await fetch(env.SUPABASE_URL + '/rest/v1/slots?purchase_id=in.(' + expiredIds + ')', {
      method: 'PATCH',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ purchase_id: null })
    });

    // Bin the abandoned uploads too, otherwise the storage bucket slowly fills
    // with artwork for purchases that no longer exist.
    await Promise.all(expired.map(async function (p) {
      if (!p.image_path) return;
      try {
        await fetch(env.SUPABASE_URL + '/storage/v1/object/artwork/' + p.image_path, {
          method: 'DELETE',
          headers: sbHeaders(env)
        });
      } catch (e) { /* best effort, an orphaned file is harmless */ }
    }));

    await cleanRateLimits(env);
  } catch (e) {
    // Best effort throughout. A failed sweep leaves things exactly as they are
    // today and the next request tries again.
  }
}

async function cleanRateLimits(env) {
  try {
    await fetch(
      env.SUPABASE_URL + '/rest/v1/rate_limits?created_at=lt.' +
        encodeURIComponent(minutesAgo(RATE_LIMIT_RETENTION_MINUTES)),
      { method: 'DELETE', headers: sbHeaders(env, { Prefer: 'return=minimal' }) }
    );
  } catch (e) { /* best effort */ }
}
