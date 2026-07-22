export async function onRequestGet(context) {
  const { env } = context;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/slots?select=col,row,is_sold`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`
    }
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Failed to fetch slots' }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' }
  });
}
