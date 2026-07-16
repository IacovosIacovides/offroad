const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter'
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: {'content-type':'application/json'}, body: JSON.stringify({error:'Method not allowed'}) };
  }

  let query;
  try {
    const body = JSON.parse(event.body || '{}');
    query = body.query;
  } catch (_) {}

  if (!query || typeof query !== 'string' || query.length > 12000) {
    return { statusCode: 400, headers: {'content-type':'application/json'}, body: JSON.stringify({error:'Invalid map query'}) };
  }

  let lastError = 'All OpenStreetMap data servers were unavailable';
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 24000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'accept': 'application/json',
          'user-agent': 'Xoma-Cyprus-Offroad/1.0 (Netlify Function)'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });
      if (!response.ok) {
        lastError = `OpenStreetMap server returned ${response.status}`;
        continue;
      }
      const text = await response.text();
      JSON.parse(text); // validate before returning
      return {
        statusCode: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=300, s-maxage=1800'
        },
        body: text
      };
    } catch (err) {
      lastError = err && err.name === 'AbortError' ? 'OpenStreetMap request timed out' : String(err && err.message || err);
    } finally {
      clearTimeout(timer);
    }
  }

  return { statusCode: 502, headers: {'content-type':'application/json'}, body: JSON.stringify({error:lastError}) };
};
