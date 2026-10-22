// End-to-end against a running server: Alexa-style account linking over HTTP, then the official MCP TypeScript SDK
// client (Streamable HTTP, protocol 2025-11-25) runs the demo story. Prints per-call latency.
// Usage: MCP_URL=http://127.0.0.1:8787/mcp CLIENT_ID=... CLIENT_SECRET=... REDIRECT_URI=... [EMAIL=..] [PASSCODE=..] node scripts/e2e.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = process.env.MCP_URL || 'http://127.0.0.1:8787/mcp';
const O = new URL(MCP).origin;
const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = process.env;
const b64url = (b) => Buffer.from(b).toString('base64url');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };

const unauth = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
assert(unauth.status === 401 && !unauth.headers.get('www-authenticate'), '401 without WWW-Authenticate');
const prm = await (await fetch(`${O}/.well-known/oauth-protected-resource`)).json();
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
assert(as.code_challenge_methods_supported.includes('S256'), 'S256 advertised');

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e', scope: prm.scopes_supported.join(' '), resource: prm.resource });
const pid = /name="pid" value="([^"]+)"/.exec(await (await fetch(`${as.authorization_endpoint}?${q}`)).text())[1];
const lr = await fetch(`${O}/login`, { method: 'POST', body: new URLSearchParams({ pid, email: process.env.EMAIL || 'e2e@example.test', passcode: process.env.PASSCODE || '' }) });
const csrf = /name="csrf" value="([^"]+)"/.exec(await lr.text())?.[1]; assert(csrf, 'login ok');
const cr = await fetch(`${O}/consent`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ pid, csrf, decision: 'approve' }) });
const code = new URL(cr.headers.get('location')).searchParams.get('code');
const tok = await (await fetch(as.token_endpoint, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64') },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: prm.resource }) })).json();
assert(tok.access_token, 'token issued');
console.log('OAuth account linking: OK');

const client = new Client({ name: 'fixwise-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
console.log('negotiated protocol:', client.transport.protocolVersion ?? '(see server)', 'server:', client.getServerVersion().name);
const lat = [];
const timed = async (name, args) => { const t = performance.now(); const r = await client.callTool({ name, arguments: args }); const ms = performance.now() - t; lat.push(ms); console.log(`\n> ${name} ${JSON.stringify(args)}  [${ms.toFixed(0)} ms]\n${r.content[0].text}`); return r; };
const tools = await client.listTools(); assert(tools.tools.length >= 10, 'tools listed');
const res = await client.listResources(); assert(res.resources.length === 3, 'ui resources');
await timed('fixwise_remember', { area: 'Melville', time_window: 'tomorrow morning' });
await timed('fixwise_report_problem', { description: "The geyser's leaking through the ceiling and the street light outside has been out for two days" });
await timed('fixwise_compare_quotes', {});
const hold = await timed('fixwise_book_repair', { rank: 1 });
await timed('fixwise_book_repair', { approval_id: hold.structuredContent.approval.id, confirm: true });
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS || 2000)));
await timed('fixwise_check_status', { issue: 'geyser' });
await timed('fixwise_activity', {});
lat.sort((a, b) => a - b);
console.log(`\nlatency ms: p50=${lat[Math.floor(lat.length / 2)].toFixed(0)} max=${lat[lat.length - 1].toFixed(0)} (Alexa+ budget 500)`);
await client.close();
