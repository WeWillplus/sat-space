function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

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

  const res = await fetch(
    env.SUPABASE_URL + '/rest/v1/purchases?select=id,slot_count,sats_amount,eur_amount,email,image_path,created_at,slots(col,row)&status=eq.paid&order=created_at.asc',
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY
      }
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'Failed to fetch review queue', status: res.status, detail: detail }, 502);
  }

  const rows = await res.json();

  const out = await Promise.all(rows.map(async function (p) {
    return {
      purchaseId: p.id,
      slotCount: p.slot_count,
      satsAmount: p.sats_amount,
      eurAmount: p.eur_amount,
      email: p.email,
      createdAt: p.created_at,
      cells: p.slots || [],
      imageUrl: p.image_path ? await signUrl(env, p.image_path) : null
    };
  }));

  return json(out);
}
