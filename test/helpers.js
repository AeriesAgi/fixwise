import { handle } from '../src/app.js';
import { newSession } from '../src/console/api.js';
const SESS = new Map();
export const newSessionFor = (k) => { if (!SESS.has(k)) SESS.set(k, newSession({})); return SESS.get(k); }; // stable signed sid per test label
import { MemoryKV } from '../src/store/kv.js';
import { sha256, b64url } from '../src/util.js';

export const O = 'https://fixwise.test';
export const REDIRECT = 'https://layla.amazon.com/api/skill/link/TESTVENDOR';
export const SECRET = 'test-client-secret-not-real-000000000000';
export async function makeEnv(extra = {}) {
  const env = { KV: new MemoryKV(), PUBLIC_ORIGIN: O, DEV_LOGIN: '1', ENVIRONMENT: 'test',
    FIXWISE_CLIENTS: JSON.stringify([{ client_id: 'alexa-test', client_name: 'Alexa', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic', secret_hash: await sha256(SECRET) }]), ...extra };
  env.MCP_FETCH ??= (u, init) => handle(new Request(u, init), env); // console MCP client -> this server over (in-memory) HTTP
  return env;
}
export const call = (env, path, init = {}, ctx = {}) => handle(new Request(O + path, init), env, ctx);
const cookieless = (r) => r;
export async function pkce() { const v = b64url(crypto.getRandomValues(new Uint8Array(32))); return { verifier: v, challenge: await sha256(v) }; }
export async function link(env, { email = 'ash@example.test', scope = 'fixwise.read fixwise.act' } = {}) {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', scope, resource: `${O}/mcp` });
  const a = await call(env, `/authorize?${q}`);
  const htmlA = await a.text(); const pid = /name="pid" value="([^"]+)"/.exec(htmlA)[1];
  const l = await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid, email, passcode: '' }) });
  const htmlL = await l.text(); const csrf = /name="csrf" value="([^"]+)"/.exec(htmlL)[1];
  const c = await call(env, '/consent', { method: 'POST', body: new URLSearchParams({ pid, csrf, decision: 'approve' }) });
  const loc = new URL(c.headers.get('location'));
  const code = loc.searchParams.get('code');
  const t = await call(env, '/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa(`alexa-test:${SECRET}`) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${O}/mcp` }) });
  return { tok: await t.json(), loc, verifier };
}
export function mcpClient(env, token, ctx = {}) {
  let id = 0;
  const rpc = async (method, params) => {
    const r = await call(env, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }, ctx);
    return r.json();
  };
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, tool };
}
