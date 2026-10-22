export const enc = new TextEncoder();
export const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const now = () => Math.floor(Date.now() / 1000);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export async function kvGet(env, key) { const v = await env.KV.get(key); return v ? JSON.parse(v) : null; }
export async function kvPut(env, key, value, ttl) { await env.KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) }); }
export async function kvDel(env, key) { await env.KV.delete(key); }
export const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'cache-control': 'no-store' };
export const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};
export function json(body, status = 200, extra = {}) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...SEC_HEADERS, ...CORS, ...extra } }); }
export function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS,
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'", 'x-frame-options': 'DENY' } });
}
export const redirect = (to) => new Response(null, { status: 302, headers: { location: to, ...SEC_HEADERS } });
export function origin(env, url) { return (env.PUBLIC_ORIGIN || url.origin).replace(/\/$/, ''); }
// PBKDF2-SHA256 passcode hash: "pbkdf2$<iter>$<salt b64url>$<hash b64url>"
export async function pbkdf2(pass, saltB64, iter) {
  const salt = Uint8Array.from(atob(saltB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export async function verifyPasscode(pass, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !iter || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(String(pass), salt, Number(iter)), hash);
}
