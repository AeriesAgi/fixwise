#!/usr/bin/env node
// Fixwise judge client. Zero dependencies, Node 18+. Proves the live MCP server end to end, the way Alexa+ connects:
//   1. 401 rules: /mcp per MCP spec (WWW-Authenticate), /alexa/mcp per Alexa+ (none)  2. OAuth discovery (RFC 9728 + RFC 8414)
//   3. OAuth 2.1 authorization code + PKCE S256 with resource indicator  4. MCP initialize (2025-11-25), tools/list, resources/list
//   5. the demo story as real tools/call requests, with latency  6. optional interactive mode
// Run:  curl -fsSL https://alexa.culltron.app/judge.mjs -o judge.mjs && node judge.mjs
//   EMAIL=judges@culltron.app PASSCODE=... node judge.mjs      (headless: no browser)
//   node judge.mjs --interactive                                (call any tool yourself)
import http from 'node:http';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.FIXWISE_URL || 'https://alexa.culltron.app').replace(/\/$/, '');
const MCP = `${BASE}/mcp`, CLIENT_ID = 'fixwise-judge', PORT = 8976, REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const INTERACTIVE = process.argv.includes('--interactive') || process.argv.includes('-i');
const b64url = (b) => Buffer.from(b).toString('base64url');
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`); const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const die = (m) => { console.error(`  \x1b[31m✘ ${m}\x1b[0m`); process.exit(1); };

step('1. Unauthenticated calls');
const unauth = (u) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
const u = await unauth(MCP);
u.status === 401 && /resource_metadata=/.test(u.headers.get('www-authenticate') || '') ? ok('/mcp: 401 with WWW-Authenticate resource_metadata (MCP 2025-11-25)') : die(`/mcp: expected 401 + WWW-Authenticate, got ${u.status}`);
const a = await unauth(`${BASE}/alexa/mcp`);
a.status === 401 && !a.headers.get('www-authenticate') ? ok('/alexa/mcp: 401 with no WWW-Authenticate (Alexa+ onboarding rule)') : die(`/alexa/mcp: expected bare 401, got ${a.status}`);

step('2. OAuth discovery');
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json(); ok(`protected resource ${prm.resource}`);
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
ok(`authorization server ${as.issuer} · PKCE ${as.code_challenge_methods_supported.join(',')} · scopes ${prm.scopes_supported.join(' ')}`);

step('3. Account linking (OAuth 2.1 + PKCE S256)');
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, scope: prm.scopes_supported.join(' '), resource: prm.resource });
const authUrl = `${as.authorization_endpoint}?${q}`;
let code;
if (process.env.EMAIL && process.env.PASSCODE) {
  const pid = /name="pid" value="([^"]+)"/.exec(await (await fetch(authUrl)).text())?.[1] || die('authorize page');
  const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${BASE}/login`, { method: 'POST', body: new URLSearchParams({ pid, email: process.env.EMAIL, passcode: process.env.PASSCODE }) })).text())?.[1] || die('login rejected (check EMAIL/PASSCODE)');
  const loc = (await fetch(`${BASE}/consent`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ pid, csrf, decision: 'approve' }) })).headers.get('location');
  code = new URL(loc).searchParams.get('code'); ok('signed in headless and approved consent');
} else {
  code = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = new URL(req.url, REDIRECT); if (p.pathname !== '/callback') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h2 style="font-family:system-ui">Fixwise linked. Return to the terminal.</h2>'); srv.close();
      if (p.searchParams.get('state') !== state) die('state mismatch'); resolve(p.searchParams.get('code'));
    }).listen(PORT, '127.0.0.1');
    console.log(`  Open this URL, sign in with the judge email and passcode, then approve:\n  ${authUrl}`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { spawn(opener, [authUrl], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  });
  ok('browser consent approved');
}
const tok = await (await fetch(as.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT_ID, resource: prm.resource }) })).json();
tok.access_token ? ok(`access token issued (${tok.expires_in}s, scope "${tok.scope}"), refresh token: ${tok.refresh_token ? 'yes' : 'no'}`) : die(JSON.stringify(tok));

if (process.env.TOKEN_FILE) writeFileSync(process.env.TOKEN_FILE, tok.access_token, { mode: 0o600 }); // for MCP Inspector: --header "Authorization: Bearer $(cat file)"

step('4. MCP session (Streamable HTTP)');
let id = 0, pv = null;
async function rpc(method, params, notify = false) {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}`, ...(pv ? { 'mcp-protocol-version': pv } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++id }) }) });
  if (notify) return null; const j = await r.json(); if (j.error) throw new Error(`${j.error.code} ${j.error.message}`); return j.result;
}
const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixwise-judge', version: '1.0.0' } });
pv = init.protocolVersion; await rpc('notifications/initialized', null, true);
ok(`initialize → ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${pv}`);
const { tools } = await rpc('tools/list', {}); ok(`${tools.length} tools: ${tools.map((t) => t.name.replace('fixwise_', '')).join(', ')}`);
const { resources } = await rpc('resources/list', {}); ok(`${resources.length} MCP Apps UI resources: ${resources.map((r) => r.uri).join(', ')}`);

const lat = [];
async function call(name, args) {
  const t = performance.now(); const r = await rpc('tools/call', { name, arguments: args }); const ms = performance.now() - t; lat.push(ms);
  console.log(`\n  \x1b[36m→ ${name}\x1b[0m ${JSON.stringify(args)}  \x1b[2m${ms.toFixed(0)} ms${r._meta?.ui?.resourceUri ? ' · card ' + r._meta.ui.resourceUri : ''}\x1b[0m\n    ${r.content?.[0]?.text}`);
  return r;
}
if (INTERACTIVE) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nInteractive. Type: <tool_name> <json args>   e.g.  report_problem {"description":"the gate motor is dead"}   (blank line to quit)');
  for (;;) { const line = (await rl.question('> ')).trim(); if (!line) break; const [n, ...rest] = line.split(' ');
    try { await call(n.startsWith('fixwise_') ? n : `fixwise_${n}`, rest.length ? JSON.parse(rest.join(' ')) : {}); } catch (e) { console.log('  error:', e.message); } }
  rl.close(); process.exit(0);
}
step('5. Demo story as real tool calls');
const rep = await call('fixwise_report_problem', { description: "The geyser's leaking through the ceiling and the street light outside has been out for two days", area: 'Melville' });
const issue = rep.structuredContent.issue.id; // the judge household is shared, so address this run's issue by id
await call('fixwise_compare_quotes', { issue });
const hold = await call('fixwise_book_repair', { issue, rank: 1 });
await call('fixwise_book_repair', { approval_id: hold.structuredContent.approval.id, confirm: true });
await call('fixwise_check_status', { issue });
await call('fixwise_activity', {});
await call('fixwise_close_issue', { issue }); // keep the shared judge household tidy
lat.sort((a, b) => a - b);
step('6. Console voice (Amazon Polly) returns real MP3');
{ const sess = await (await fetch(`${BASE}/console/api/session`, { method: 'POST' })).json();
  if (!sess.sid) die('console session failed');
  const r = await fetch(`${BASE}/console/api/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: sess.sid, text: 'Fixwise voice check.' }) });
  if (r.status !== 200 || r.headers.get('content-type') !== 'audio/mpeg') die(`TTS returned ${r.status} ${r.headers.get('content-type')}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.includes(Buffer.from([0xef, 0xbf, 0xbd]))) die('TTS bytes were mangled as UTF-8 text');
  let o = 0; if (b.subarray(0, 3).toString() === 'ID3') o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]); // skip the ID3v2 tag
  if (!(b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0)) die('TTS audio has no MPEG frame sync');
  ok(`${b.length} bytes, MPEG frame sync at byte ${o}, voice ${r.headers.get('x-fixwise-voice')}`); }
step('7. Result');
ok(`all checks passed · ${lat.length} tool calls · round-trip p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)} ms, max ${lat[lat.length - 1].toFixed(0)} ms from your machine (Alexa+ budget 500 ms)`);
console.log('  Try it yourself: node judge.mjs --interactive');
