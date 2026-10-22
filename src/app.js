// HTTP router shared by the local Node server and the AWS Lambda handler.
import { routeOAuth, page } from './oauth/oauth.js';
import { mcp } from './mcp/server.js';
import { routeConsole } from './console/api.js';
import { readFileSync } from 'node:fs';
import { serveIcs } from './domain/calendar.js';
import { serveLandlord } from './domain/landlord.js';
import { json, html, esc, origin, CORS, SEC_HEADERS } from './util.js';

const JUDGE = readFileSync(new URL('./judge/judge.mjs', import.meta.url), 'utf8');

export async function handle(req, env, ctx = {}) {
  const url = new URL(req.url);
  const o = origin(env, url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const oa = await routeOAuth(req, env, url, path);
    if (oa) return oa;
    if (path === '/mcp') return await mcp(req, env, url, ctx);
    if (path === '/alexa/mcp') return await mcp(req, env, url, ctx, { alexa: true }); // Alexa+ onboarding URL: 401 without WWW-Authenticate
    if (path.startsWith('/console')) { const c = await routeConsole(req, env, url, path, ctx); if (c) return c; }
    if (path === '/judge.mjs') return new Response(JUDGE, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SEC_HEADERS, 'cache-control': 'public, max-age=300' } });
    if (path === '/ics' && req.method === 'GET') return serveIcs(env, url) || json({ error: 'invalid_link' }, 404);
    if (path === '/landlord' && req.method === 'GET') return (await serveLandlord(env, url)) || html(page('Link expired', '<p>This landlord link is invalid or has expired. Ask your tenant for a new one.</p>'), 404);
    if (path === '/health') return json({ ok: true, service: 'fixwise', version: '1.0.0', protocol: '2025-11-25' });
    if (path === '/') return html(page('Fixwise for Alexa+', `<p>Tell Alexa what's broken at home or on your street. Fixwise gives safety steps first, logs the municipal case, gets priced quotes and books only when you say yes.</p><p>MCP server URL: <code>${esc(o)}/mcp</code></p><p><a style="color:#3ddc97" href="/console">Try the simulated Alexa+ console →</a></p><p>Judges, connect your own MCP client in one command: <code>curl -fsSL ${esc(o)}/judge.mjs -o judge.mjs &amp;&amp; node judge.mjs</code></p>`));
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', err: String(e && e.message).slice(0, 200) }));
    return json({ error: 'server_error' }, 500);
  }
}
