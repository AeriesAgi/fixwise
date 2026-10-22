// Cloudflare Worker in front of the Lambda Function URL (alexa.culltron.app).
// Bindings (set at deploy, never committed): ORIGIN_URL (plain text), ORIGIN_SECRET (secret), RL (rate limiter, 30/min per IP).
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    if (u.pathname.startsWith('/console/api/') && env.RL) {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return new Response(JSON.stringify({ error: 'rate_limited', speech: 'Slow down a little. Try again in a minute.' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
    }
    const origin = env.ORIGIN_URL.replace(/\/$/, '');
    const h = new Headers(req.headers);
    h.delete('host'); h.delete('x-fixwise-origin');
    h.set('x-forwarded-host', u.host); h.set('x-forwarded-proto', 'https'); h.set('cf-connecting-ip', ip);
    h.set('x-fixwise-origin', env.ORIGIN_SECRET);
    const init = { method: req.method, headers: h, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
    const r = await fetch(origin + u.pathname + u.search, init);
    const rh = new Headers(r.headers);
    // Lambda Function URLs rename WWW-Authenticate to x-amzn-remapped-www-authenticate; put the MCP-spec header back.
    const wa = rh.get('x-amzn-remapped-www-authenticate'); if (wa) { rh.set('www-authenticate', wa); rh.delete('x-amzn-remapped-www-authenticate'); }
    const loc = rh.get('location'); if (loc && loc.startsWith(origin)) rh.set('location', 'https://' + u.host + loc.slice(origin.length));
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: rh });
  },
};
