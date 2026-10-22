import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeEnv, call, newSessionFor } from './helpers.js';
import { newSession, verifySession } from '../src/console/api.js';
import { originLocked, serve } from '../src/lambda.js';
import { RESOURCES } from '../src/ui/cards.js';

const post = (env, path, body, headers = {}) => call(env, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('sessions are server-issued and HMAC-signed; forged or client-made ids are refused', async () => {
  const env = await makeEnv();
  const r = await call(env, '/console/api/session', { method: 'POST' }); const { sid } = await r.json();
  assert.equal(r.status, 200); assert.ok(verifySession(env, sid));
  assert.equal(verifySession(env, sid.slice(0, -1) + (sid.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(verifySession({ SESSION_SECRET: 'other' }, sid), false);
  for (const bad of ['abcdefghijklmnopqrstuvwxyz012345', '', null]) assert.equal((await post(env, '/console/api/say', { sid: bad, text: 'hi' })).status, 400);
  assert.equal(newSession({ ENVIRONMENT: 'production' }), null); // fails closed without SESSION_SECRET
  assert.equal((await call(await makeEnv({ ENVIRONMENT: 'production', SESSION_SECRET: undefined }), '/console/api/session', { method: 'POST' })).status, 503);
});

test('per-session and per-IP limits return 429 before any model call', async () => {
  let calls = 0; const env = await makeEnv({ CONSOLE_PER_SESSION_MIN: '3', CONSOLE_PER_IP_MIN: '5', BEDROCK: { send: async () => { calls++; throw new Error('x'); } } });
  const s = newSessionFor('sec-limit-a'); const st = [];
  for (let i = 0; i < 4; i++) st.push((await post(env, '/console/api/say', { sid: s, text: 'hello' }, { 'cf-connecting-ip': '198.51.100.7' })).status);
  assert.deepEqual(st, [200, 200, 200, 429]);
  const before = calls; const t = newSessionFor('sec-limit-b'); const st2 = [];
  for (let i = 0; i < 3; i++) st2.push((await post(env, '/console/api/say', { sid: t, text: 'hello' }, { 'cf-connecting-ip': '198.51.100.7' })).status);
  assert.deepEqual(st2, [200, 429, 429]); // 5 per IP per minute, counting the refused one
  assert.ok(calls - before <= 2);
});

test('global Nova ceiling per hour falls back to the regex router', async () => {
  let calls = 0; const env = await makeEnv({ NOVA_PER_HOUR: '1', CONSOLE_MODEL_ID: 'us.amazon.nova-lite-v1:0', BEDROCK: { send: async () => { calls++; return { output: { message: { content: [{ text: 'Hi.' }] } }, usage: {} }; } } });
  const s = newSessionFor('sec-nova'); await post(env, '/console/api/say', { sid: s, text: 'hello' });
  const r = await (await post(env, '/console/api/say', { sid: s, text: 'the geyser is leaking' })).json();
  assert.equal(r.fallbackReason, 'nova_hourly_ceiling'); assert.match(r.speech, /geyser/i); assert.ok(calls <= 1);
});

test('strict CSP: no inline script on the console; cards allowed only by their own hash', async () => {
  const env = await makeEnv(); const page = await call(env, '/console');
  const csp = page.headers.get('content-security-policy'); assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  const html = await page.text(); assert.doesNotMatch(html, /<script>(?!<\/script>)/); assert.match(html, /src="\/console\/app\.js"/);
  const js = await call(env, '/console/app.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  for (const r of RESOURCES) {
    const c = await call(env, '/console/card?uri=' + encodeURIComponent(r.uri)); const p = c.headers.get('content-security-policy');
    const body = await c.text(); const inl = /<script>([\s\S]*?)<\/script>/.exec(body)[1];
    assert.ok(p.includes(`'sha256-${createHash('sha256').update(inl).digest('base64')}'`), r.uri); assert.doesNotMatch(p, /script-src[^;]*unsafe-inline/);
  }
});

test('cards pin postMessage to the parent and ignore other senders', () => {
  for (const r of RESOURCES) { assert.match(r.html, /ancestorOrigins/); assert.match(r.html, /e\.source\s*!==\s*window\.parent|e\.source!==window\.parent/); }
});

test('origin lock: the raw Function URL answers 403 without the Worker secret', async () => {
  const env = { ENVIRONMENT: 'production', ORIGIN_SECRET: 'worker-secret-test-0000' };
  const ev = (h = {}) => ({ rawPath: '/mcp', headers: h, requestContext: { http: { method: 'POST' } } });
  assert.equal(originLocked(ev(), env), true); assert.equal(originLocked(ev({ 'x-fixwise-origin': 'nope' }), env), true);
  assert.equal(originLocked(ev({ 'x-fixwise-origin': 'worker-secret-test-0000' }), env), false);
  assert.equal(originLocked(ev(), { ENVIRONMENT: 'production' }), true); // fail closed if unset
  assert.equal(originLocked(ev(), {}), false); // local dev
  assert.equal((await serve(ev(), env)).statusCode, 403);
});
