function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

async function fetchCoinGecko() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'SatSpace/1.0 (+https://sat-space.pages.dev)'
    }
  });
  if (!res.ok) throw new Error('CoinGecko ' + res.status + ': ' + (await res.text()));
  const data = await res.json();
  const rate = data && data.bitcoin && data.bitcoin.eur;
  if (!rate) throw new Error('CoinGecko: rate missing in response');
  return rate;
}

async function fetchKraken() {
  const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTEUR');
  if (!res.ok) throw new Error('Kraken ' + res.status + ': ' + (await res.text()));
  const data = await res.json();
  if (data.error && data.error.length) throw new Error('Kraken: ' + data.error.join(', '));
  const key = Object.keys(data.result)[0];
  const rate = key && data.result[key] && parseFloat(data.result[key].c[0]);
  if (!rate) throw new Error('Kraken: rate missing in response');
  return rate;
}

export async function onRequestGet(context) {
  const sources = [['coingecko', fetchCoinGecko], ['kraken', fetchKraken]];
  const errors = [];

  for (const [name, fn] of sources) {
    try {
      const rate = await fn();
      return json({ rate: rate, source: name, fetchedAt: new Date().toISOString() });
    } catch (e) {
      errors.push(e.message);
    }
  }

  return json({ error: 'Failed to fetch rate from any source', detail: errors.join(' | ') }, 502);
}
