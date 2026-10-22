// Fixwise account linking: an OAuth 2.1 authorization server and protected-resource metadata, written for Alexa+.
// Alexa+ rules shape the design: clients are pre-registered (no Dynamic Client Registration unless ENABLE_DCR=1),
// sign-in is our own household email + passcode (no OIDC), PKCE S256 is mandatory, and the RFC 8707 `resource`
// must be repeated at the token step when it was sent at /authorize. Tokens are stored only as SHA-256 hashes.
import { randomToken, sha256, now, esc, timingSafeEqual, kvGet, kvPut, kvDel, json, html, redirect, origin, verifyPasscode, CORS, SEC_HEADERS } from '../util.js';

export const SCOPES = ['fixwise.read', 'fixwise.act'];
const TTL = { access: 3600, refresh: 30 * 86400, code: 300, link: 600, client: 180 * 86400 };
const LOGIN = { perLink: 5, perEmail: 10, perIp: 30, windowS: 900 }; // passcode attempts; PBKDF2 is costly, so cap before hashing
const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'];
const K = { access: (h) => `tok:a:${h}`, refresh: (h) => `tok:r:${h}`, grant: (id) => `grant:${id}`, code: (h) => `authcode:${h}`, link: (id) => `link:${id}`, dcr: (id) => `dcr:${id}` };

const fail = (error, error_description, status = 400) => json({ error, error_description }, status);
const parseJson = (s, dflt) => { try { return JSON.parse(s || ''); } catch { return dflt; } };
const isDev = (env) => env.DEV_LOGIN === '1' && env.ENVIRONMENT !== 'production';
const resourceOf = (o) => `${o}/mcp`;
const knownResource = (o, r) => r === resourceOf(o) || r === o;

export function authServerMetadata(o, env) {
  return {
    issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, revocation_endpoint: `${o}/revoke`,
    ...(env.ENABLE_DCR === '1' ? { registration_endpoint: `${o}/register` } : {}),
    response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: AUTH_METHODS, revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: SCOPES, service_documentation: `${o}/`,
  };
}
export const resourceMetadata = (o) => ({ resource: resourceOf(o), authorization_servers: [o], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Fixwise' });

async function lookupClient(env, clientId) {
  if (!clientId) return null;
  const fixed = parseJson(env.FIXWISE_CLIENTS, []).find((c) => c.client_id === clientId);
  if (fixed) return fixed;
  return env.ENABLE_DCR === '1' ? kvGet(env, K.dcr(clientId)) : null;
}
function acceptableRedirect(u) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.hash) return false;
  return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
}

async function registerClient(req, env) {
  if (env.ENABLE_DCR !== '1') return json({ error: 'not_found' }, 404);
  const meta = await req.json().catch(() => null);
  if (!meta || typeof meta !== 'object') return fail('invalid_client_metadata', 'Body must be JSON.');
  const uris = meta.redirect_uris;
  const urisOk = Array.isArray(uris) && uris.length >= 1 && uris.length <= 10 && uris.every((u) => typeof u === 'string' && u.length <= 2000 && acceptableRedirect(u));
  if (!urisOk) return fail('invalid_redirect_uri', 'redirect_uris must be 1-10 https URLs (http allowed only for localhost).');
  const method = meta.token_endpoint_auth_method || 'client_secret_basic';
  if (!AUTH_METHODS.includes(method)) return fail('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
  const record = { client_id: `dcr_${randomToken(18)}`, client_name: String(meta.client_name || 'MCP client').slice(0, 100), redirect_uris: uris, token_endpoint_auth_method: method };
  const reply = { ...record, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: now() };
  if (method !== 'none') { const secret = randomToken(32); record.secret_hash = await sha256(secret); Object.assign(reply, { client_secret: secret, client_secret_expires_at: 0 }); }
  await kvPut(env, K.dcr(record.client_id), record, TTL.client);
  return json(reply, 201);
}

// GET /authorize: validate, then park the request under a one-time link id while the household signs in.
async function startAuthorization(url, env) {
  const q = url.searchParams; const o = origin(env, url);
  const client = await lookupClient(env, q.get('client_id'));
  if (!client) return html(page('Unknown app', '<p>This app is not registered with Fixwise.</p>'), 400);
  const redirectUri = q.get('redirect_uri');
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return html(page('Invalid redirect', '<p>The redirect address does not match this app.</p>'), 400);
  const bounce = (error, why) => {
    const to = new URL(redirectUri);
    for (const [k, v] of Object.entries({ error, error_description: why, state: q.get('state'), iss: o })) if (v) to.searchParams.set(k, v);
    return redirect(to.toString());
  };
  if (q.get('response_type') !== 'code') return bounce('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = q.get('code_challenge') || '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return bounce('invalid_request', 'PKCE with S256 is required.');
  if (q.has('resource') && !knownResource(o, q.get('resource'))) return bounce('invalid_target', 'Unknown resource.');
  const asked = [...new Set((q.get('scope') || SCOPES.join(' ')).split(/[ +]/).filter(Boolean))];
  if (!asked.every((s) => SCOPES.includes(s))) return bounce('invalid_scope', `Available scopes: ${SCOPES.join(' ')}.`);
  const linkId = randomToken(24);
  await kvPut(env, K.link(linkId), { client_id: client.client_id, client_name: client.client_name, redirect_uri: redirectUri, state: q.get('state'),
    code_challenge: challenge, resource: resourceOf(o), resource_sent: q.has('resource'), scope: asked.join(' '), csrf: randomToken(24), attempts: 0 }, TTL.link);
  return html(loginPage(linkId, isDev(env)));
}

const clientIp = (req) => (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

// POST /login: household email + passcode. Throttled per link, per email and per IP before any PBKDF2 work.
async function signIn(req, env) {
  const form = await req.formData();
  const linkId = String(form.get('pid') || ''); const pending = await kvGet(env, K.link(linkId));
  if (!pending) return html(page('Sign-in expired', '<p>Please start again from the Alexa app.</p>'), 400);
  const email = String(form.get('email') || '').trim().toLowerCase();
  const win = Math.floor(now() / LOGIN.windowS);
  const [byEmail, byIp] = await Promise.all([env.KV.incr(`lim:login:e:${await sha256(email)}:${win}`, LOGIN.windowS), env.KV.incr(`lim:login:i:${await sha256(clientIp(req))}:${win}`, LOGIN.windowS)]);
  if (byEmail > LOGIN.perEmail || byIp > LOGIN.perIp) return html(page('Too many attempts', '<p>Too many sign-in attempts. Wait 15 minutes, then start again from the Alexa app.</p>'), 429);
  let user = null;
  const household = parseJson(env.HOUSEHOLDS, []).find((h) => String(h.email).toLowerCase() === email);
  if (household && await verifyPasscode(String(form.get('passcode') || ''), household.passcode_hash)) user = { sub: `hh:${household.id}`, email, name: household.name || email };
  else if (isDev(env) && /^[^@\s]+@[^@\s]+$/.test(email)) user = { sub: `dev:${email}`, email, name: email };
  if (!user) {
    pending.attempts = (pending.attempts || 0) + 1;
    if (pending.attempts >= LOGIN.perLink) { await kvDel(env, K.link(linkId)); return html(page('Too many attempts', '<p>That sign-in was closed after too many wrong passcodes. Start again from the Alexa app.</p>'), 429); }
    await kvPut(env, K.link(linkId), pending, TTL.link);
    return html(loginPage(linkId, isDev(env), 'That email and passcode do not match a Fixwise household.'), 403);
  }
  await kvPut(env, K.link(linkId), { ...pending, user }, TTL.link);
  return html(consentPage(linkId, { ...pending, user }));
}

// POST /consent: allow or deny; on allow, mint a single-use code bound to client, redirect, PKCE challenge and resource.
async function decide(req, env, url) {
  const form = await req.formData();
  const linkId = String(form.get('pid') || ''); const pending = await kvGet(env, K.link(linkId));
  if (!pending?.user || !timingSafeEqual(form.get('csrf') || '', pending.csrf)) return html(page('Request expired', '<p>Please start again from the Alexa app.</p>'), 400);
  await kvDel(env, K.link(linkId));
  const to = new URL(pending.redirect_uri);
  if (pending.state) to.searchParams.set('state', pending.state);
  to.searchParams.set('iss', origin(env, url));
  if (form.get('decision') !== 'approve') { to.searchParams.set('error', 'access_denied'); return redirect(to.toString()); }
  const code = randomToken(32);
  const { client_id, redirect_uri, code_challenge, resource, resource_sent, scope, user } = pending;
  await kvPut(env, K.code(await sha256(code)), { client_id, redirect_uri, code_challenge, resource, resource_sent, scope, user, exp: now() + TTL.code }, TTL.code);
  to.searchParams.set('code', code);
  return redirect(to.toString());
}

// Client authentication: HTTP Basic (split on the FIRST colon, so secrets may contain ':'), form post, or none for public PKCE clients.
async function authenticateClient(req, form, env) {
  let id = form.get('client_id'), secret = form.get('client_secret');
  const hdr = req.headers.get('authorization') || '';
  if (hdr.startsWith('Basic ')) {
    let raw; try { raw = atob(hdr.slice(6)); } catch { return null; }
    const cut = raw.indexOf(':'); if (cut < 0) return null;
    try { id = decodeURIComponent(raw.slice(0, cut)); secret = decodeURIComponent(raw.slice(cut + 1)); } catch { return null; }
  }
  const client = await lookupClient(env, id);
  if (!client) return null;
  if (client.token_endpoint_auth_method === 'none') return client;
  return secret && client.secret_hash && timingSafeEqual(await sha256(secret), client.secret_hash) ? client : null;
}

async function mint(env, g, grantId = randomToken(16)) {
  const access = randomToken(32), refresh = randomToken(32);
  const claims = { client_id: g.client_id, user: g.user, scope: g.scope, resource: g.resource, family: grantId };
  await kvPut(env, K.access(await sha256(access)), { ...claims, exp: now() + TTL.access }, TTL.access);
  await kvPut(env, K.refresh(await sha256(refresh)), { ...claims, exp: now() + TTL.refresh }, TTL.refresh);
  await kvPut(env, K.grant(grantId), { active: true, user: g.user.sub }, TTL.refresh);
  return json({ access_token: access, token_type: 'Bearer', expires_in: TTL.access, refresh_token: refresh, scope: g.scope });
}
const retireGrant = async (env, id) => { const g = await kvGet(env, K.grant(id)); if (g) await kvPut(env, K.grant(id), { ...g, active: false }, TTL.refresh); };

async function exchange(req, env, url) {
  const form = await req.formData().catch(() => null);
  if (!form) return fail('invalid_request', 'Form body required.');
  const client = await authenticateClient(req, form, env);
  if (!client) return fail('invalid_client', 'Client authentication failed.', 401);
  const o = origin(env, url); const resource = form.get('resource');
  if (resource && !knownResource(o, resource)) return fail('invalid_target', 'Unknown resource.');
  switch (form.get('grant_type')) {
    case 'authorization_code': {
      const key = K.code(await sha256(form.get('code') || ''));
      const c = await kvGet(env, key);
      if (!c) return fail('invalid_grant', 'Code is invalid or already used.');
      await kvDel(env, key); // single use, even if the checks below fail
      const verifier = form.get('code_verifier') || '';
      const bound = c.exp >= now() && c.client_id === client.client_id && c.redirect_uri === form.get('redirect_uri')
        && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && timingSafeEqual(await sha256(verifier), c.code_challenge) && (!c.resource_sent || !!resource);
      return bound ? mint(env, c) : fail('invalid_grant', 'Authorization code binding failed.');
    }
    case 'refresh_token': {
      const key = K.refresh(await sha256(form.get('refresh_token') || ''));
      const r = await kvGet(env, key);
      if (!r || r.client_id !== client.client_id) return fail('invalid_grant', 'Refresh token is invalid.');
      const grant = await kvGet(env, K.grant(r.family));
      if (!grant?.active || r.used) { await retireGrant(env, r.family); return fail('invalid_grant', 'Refresh token is invalid.'); } // reuse => whole grant revoked
      await kvPut(env, key, { ...r, used: true }, TTL.refresh);
      return mint(env, r, r.family);
    }
    default: return fail('unsupported_grant_type', 'Unsupported grant_type.');
  }
}

async function revokeToken(req, env) {
  const form = await req.formData().catch(() => null);
  if (!form) return fail('invalid_request', 'Form body required.');
  const client = await authenticateClient(req, form, env);
  if (!client) return fail('invalid_client', 'Client authentication failed.', 401);
  const h = await sha256(form.get('token') || '');
  for (const key of [K.access(h), K.refresh(h)]) {
    const t = await kvGet(env, key);
    if (t?.client_id === client.client_id) { await retireGrant(env, t.family); await kvDel(env, key); }
  }
  return new Response(null, { status: 200, headers: { ...SEC_HEADERS, ...CORS } });
}

// Resource-server side: a bearer is valid only if unexpired, issued for this server's /mcp, and its grant is still active.
export async function bearer(req, env, o) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const t = await kvGet(env, K.access(await sha256(m[1])));
  if (!t || t.exp < now() || t.resource !== resourceOf(o)) return null;
  return (await kvGet(env, K.grant(t.family)))?.active ? t : null;
}
export async function revokeFamily(env, g) { await kvPut(env, K.grant(g.family), { active: false, user: g.user.sub, revoked: now() }, 3600); }

const ROUTES = {
  'POST /register': (req, env) => registerClient(req, env), 'GET /authorize': (req, env, url) => startAuthorization(url, env),
  'POST /login': (req, env) => signIn(req, env), 'POST /consent': (req, env, url) => decide(req, env, url),
  'POST /token': (req, env, url) => exchange(req, env, url), 'POST /revoke': (req, env) => revokeToken(req, env),
};
export async function routeOAuth(req, env, url, path) {
  const o = origin(env, url); const cache = { 'cache-control': 'public, max-age=300' };
  if (/^\/\.well-known\/oauth-authorization-server(\/mcp)?$/.test(path)) return json(authServerMetadata(o, env), 200, cache);
  if (/^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) return json(resourceMetadata(o), 200, cache);
  const h = ROUTES[`${req.method} ${path}`];
  return h ? h(req, env, url) : null;
}

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Fixwise</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0d1b1e;color:#eef6f4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{background:#15292d;border-radius:16px;padding:32px;max-width:420px;width:90%;box-shadow:0 10px 40px #0006}h1{font-size:1.3rem;margin-top:0}.brand{color:#3ddc97;font-weight:700;letter-spacing:.02em}
button,input{font:inherit;padding:11px 14px;border-radius:10px;border:1px solid #2c4a50}button{cursor:pointer;background:#3ddc97;color:#06231a;border:0;margin-right:8px;font-weight:600}
button.secondary{background:#24403f;color:#eef6f4}input{width:100%;box-sizing:border-box;background:#0d1b1e;color:#eef6f4;margin:6px 0 14px}ul{padding-left:20px}.muted{color:#9dbab4;font-size:.9rem}.err{color:#ff9b8a}</style>
</head><body><main><p class="brand">Fixwise</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
function loginPage(linkId, dev, err = '') {
  return page('Link your household', `${err ? `<p class="err">${esc(err)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="pid" value="${esc(linkId)}">
<label>Email<input name="email" type="email" required autocomplete="email"></label><label>Household passcode<input name="passcode" type="password" ${dev ? '' : 'required'} autocomplete="current-password"></label>
<button type="submit">Continue</button></form>${dev ? '<p class="muted">Local development: any email signs in.</p>' : ''}`);
}
function consentPage(linkId, p) {
  return page('Allow Alexa to use Fixwise?', `<p><strong>${esc(p.client_name)}</strong> wants to act for <strong>${esc(p.user.email)}</strong>.</p>
<ul><li>Report home and street problems, and track them</li><li>Get repair quotes from local suppliers</li><li>Book a repair <em>only</em> after you say yes to the exact quote</li></ul>
<p class="muted">You can disconnect at any time by saying "Alexa, disconnect Fixwise". Redirects to: ${esc(new URL(p.redirect_uri).origin)}</p>
<form method="post" action="/consent"><input type="hidden" name="pid" value="${esc(linkId)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button name="decision" value="approve" type="submit">Allow</button><button class="secondary" name="decision" value="deny" type="submit">Deny</button></form>`);
}

// Console-only token: the simulated Alexa+ console calls the public /mcp like any MCP client, so each anonymous demo
// household gets a short-lived bearer for that resource. It never touches a real household.
export async function issueConsoleToken(env, g, o, ttl = 3000) {
  const access = randomToken(32);
  await kvPut(env, K.access(await sha256(access)), { client_id: 'console', user: g.user, scope: g.scope, resource: resourceOf(o), family: g.family, exp: now() + ttl }, ttl);
  await kvPut(env, K.grant(g.family), { active: true, user: g.user.sub }, ttl);
  return { token: access, exp: now() + ttl };
}
