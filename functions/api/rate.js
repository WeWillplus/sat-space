export async function onRequestGet(context) {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur', {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const detail = await res.text();
    return new Response(JSON.stringify({ error: 'Failed to fetch rate', status: res.status, detail: detail }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
  const data = await res.json();
  const rate = data && data.bitcoin && data.bitcoin.eur;
  if (!rate) {
    return new Response(JSON.stringify({ error: 'Rate not available' }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ rate: rate, fetchedAt: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json' }
  });
}
