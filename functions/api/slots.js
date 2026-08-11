import { json, sweepExpired } from '../../lib/api-guards.js';

// The sweep is cheap but this endpoint runs on every single page load, so it
// is throttled rather than run every time. A missed sweep costs nothing, the
// next request picks it up.
const SWEEP_INTERVAL_MS = 60000;
let lastSweep = 0;

async function signUrl(env, path) {
  const res = await fetch(env.SUPABASE_URL + '/storage/v1/object/sign/artwork/' + path, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.signedURL ? env.SUPABASE_URL + '/storage/v1' + data.signedURL : null;
}

export async function onRequestGet(context) {
  const { env } = context;

  // Release abandoned reservations so the grid we are about to return is
  // honest about what is actually for sale. waitUntil lets this finish after
  // the response has already gone out, so nobody waits for it.
  if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = Date.now();
    context.waitUntil(sweepExpired(env));
  }

  const res = await fetch(
    env.SUPABASE_URL + '/rest/v1/slots?select=col,row,is_sold,purchase_id,purchases(status,image_path,art_zoom,art_offset_x,art_offset_y)',
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY
      }
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'Failed to fetch slots', status: res.status, detail: detail }, 502);
  }

  const rows = await res.json();

  const paths = Array.from(new Set(
    rows.filter(function (r) { return r.is_sold && r.purchases && r.purchases.status === 'approved' && r.purchases.image_path; })
        .map(function (r) { return r.purchases.image_path; })
  ));
  const signedPairs = await Promise.all(paths.map(async function (p) { return [p, await signUrl(env, p)]; }));
  const signedMap = {};
  signedPairs.forEach(function (pair) { signedMap[pair[0]] = pair[1]; });

  const out = rows.map(function (row) {
    const p = row.purchases;
    const entry = { col: row.col, row: row.row, is_sold: row.is_sold };
    if (row.is_sold && p) {
      entry.status = p.status;
      entry.purchaseId = row.purchase_id;
      if (p.status === 'approved' && p.image_path) {
        entry.imageUrl = signedMap[p.image_path];
        entry.artZoom = p.art_zoom;
        entry.artOffsetX = p.art_offset_x;
        entry.artOffsetY = p.art_offset_y;
      }
    }
    return entry;
  });

  return json(out);
}
