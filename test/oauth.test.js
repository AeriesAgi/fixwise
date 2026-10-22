import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, O, REDIRECT, SECRET, pkce } from './helpers.js';

test('PRM and AS metadata meet Alexa+ discovery rules', async () => {
  const env = await makeEnv();
  const prm = await (await call(env, '/.well-known/oauth-protected-resource')).json();
  assert.equal(prm.resource, `${O}/mcp`); assert.deepEqual(prm.authorization_servers, [O]); assert.ok(prm.scopes_supported.length);
  const as = await (await call(env, '/.well-known/oauth-authorization-server')).json();
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
  assert.equal(as.registration_endpoint, undefined, 'DCR off by default (Alexa+ does not use it)');
});

test('Alexa+ mount /alexa/mcp: 401 with no WWW-Authenticate header', async () => {
  const env = await makeEnv();
  const r = await call(env, '/alexa/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
  assert.equal(r.status, 401); assert.equal(r.headers.get('www-authenticate'), null);
});

test('spec mount /mcp: 401 carries WWW-Authenticate with resource_metadata (MCP 2025-11-25)', async () => {
  const env = await makeEnv();
  const r = await call(env, '/mcp', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/fixwise\.test\/\.well-known\/oauth-protected-resource"/);
});

test('a token works on both mounts', async () => {
  const env = await makeEnv(); const { tok } = await link(env);
  for (const p of ['/mcp', '/alexa/mcp']) { const r = await call(env, p, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }); assert.equal(r.status, 200); }
});

test('passcode attempts are capped per sign-in link and per email', async () => {
  const env = await makeEnv({ ENVIRONMENT: 'production', HOUSEHOLDS: JSON.stringify([{ id: 'd', email: 'j@example.test', passcode_hash: 'pbkdf2$1000$AAAAAAAAAAAAAAAAAAAAAA$x' }]) });
  const { challenge } = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
  const pid = /name="pid" value="([^"]+)"/.exec(await (await call(env, `/authorize?${q}`)).text())[1];
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid, email: 'j@example.test', passcode: 'wrong' + i }) })).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 429, 400]);
  for (let i = 0; i < 6; i++) { const p2 = /name="pid" value="([^"]+)"/.exec(await (await call(env, `/authorize?${q}`)).text())[1]; await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid: p2, email: 'j@example.test', passcode: 'x' }) }); }
  const p3 = /name="pid" value="([^"]+)"/.exec(await (await call(env, `/authorize?${q}`)).text())[1];
  assert.equal((await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid: p3, email: 'j@example.test', passcode: 'x' }) })).status, 429);
});

test('Basic client auth keeps secrets that contain a colon', async () => {
  const { sha256 } = await import('../src/util.js');
  const env = await makeEnv({ FIXWISE_CLIENTS: JSON.stringify([{ client_id: 'c', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic', secret_hash: await sha256('a:b:c') }]) });
  const r = await call(env, '/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa('c:a:b:c') }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'nope' }) });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_grant');
});

test('full account-linking flow: code + PKCE + resource -> tokens; code is single use', async () => {
  const env = await makeEnv();
  const { tok, loc } = await link(env);
  assert.equal(loc.searchParams.get('state'), 'st1'); assert.equal(loc.searchParams.get('iss'), O);
  assert.equal(tok.token_type, 'Bearer'); assert.ok(tok.access_token && tok.refresh_token);
});

test('token request without resource fails when authorize sent resource', async () => {
  const env = await makeEnv();
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `${O}/mcp` });
  const pid = /name="pid" value="([^"]+)"/.exec(await (await call(env, `/authorize?${q}`)).text())[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await (await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid, email: 'a@example.test' }) })).text())[1];
  const code = new URL((await call(env, '/consent', { method: 'POST', body: new URLSearchParams({ pid, csrf, decision: 'approve' }) })).headers.get('location')).searchParams.get('code');
  const t = await call(env, '/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa(`alexa-test:${SECRET}`) }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }) });
  assert.equal(t.status, 400);
});

test('wrong client secret, wrong redirect, and plain PKCE are refused', async () => {
  const env = await makeEnv();
  const t = await call(env, '/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa('alexa-test:nope') }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x' }) });
  assert.equal(t.status, 401);
  const r = await call(env, `/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`);
  assert.equal(r.status, 400);
  const p = await call(env, `/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' })}`);
  assert.equal(p.status, 302); assert.equal(new URL(p.headers.get('location')).searchParams.get('error'), 'invalid_request');
});

test('refresh rotates; reusing an old refresh token revokes the family', async () => {
  const env = await makeEnv();
  const { tok } = await link(env);
  const auth = { authorization: 'Basic ' + btoa(`alexa-test:${SECRET}`) };
  const r1 = await (await call(env, '/token', { method: 'POST', headers: auth, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, resource: `${O}/mcp` }) })).json();
  assert.ok(r1.access_token);
  const reuse = await call(env, '/token', { method: 'POST', headers: auth, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }) });
  assert.equal(reuse.status, 400);
  const after = await call(env, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${r1.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(after.status, 401, 'family revoked after reuse');
});

test('production refuses dev login and accepts only a hashed household passcode', async () => {
  const { pbkdf2, b64url } = await import('../src/util.js');
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = `pbkdf2$1000$${salt}$${await pbkdf2('correct horse', salt, 1000)}`;
  const env = await makeEnv({ DEV_LOGIN: '1', ENVIRONMENT: 'production', HOUSEHOLDS: JSON.stringify([{ id: 'demo', email: 'judge@example.test', name: 'Judge', passcode_hash: hash }]) });
  const { challenge } = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: 'alexa-test', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
  const pid = /name="pid" value="([^"]+)"/.exec(await (await call(env, `/authorize?${q}`)).text())[1];
  const bad = await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid, email: 'someone@example.test', passcode: 'x' }) });
  assert.equal(bad.status, 403);
  const ok = await call(env, '/login', { method: 'POST', body: new URLSearchParams({ pid, email: 'judge@example.test', passcode: 'correct horse' }) });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /Allow Alexa/);
});
