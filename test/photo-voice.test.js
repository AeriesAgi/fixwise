import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient, newSessionFor } from './helpers.js';
import { decodeImage, parseDiagnosis } from '../src/domain/vision.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG'), Buffer.alloc(600, 1)]).toString('base64');
const dx = (o = {}) => JSON.stringify({ is_repair_problem: true, where: 'home', item: 'geyser', problem: 'Water is dripping from the geyser pressure valve onto the ceiling board.', likely_cause: 'A failed pressure-relief valve.', severity: 'urgent', hazards: [], trade: 'plumbing', description: 'the geyser is leaking from the pressure valve', confidence: 0.86, ...o });
const vision = (text, seen = []) => ({ converse: async (input) => { seen.push(input); return { output: { message: { content: [{ text }] } }, usage: { inputTokens: 1300, outputTokens: 120 } }; } });

test('image validation: type, magic bytes and size', () => {
  assert.ok(decodeImage(JPEG, 'image/jpeg').bytes);
  assert.match(decodeImage(JPEG, 'image/gif').error, /JPEG/);
  assert.match(decodeImage(PNG, 'image/jpeg').error, /not the photo type/);
  assert.match(decodeImage('AAAA', 'image/jpeg').error, /too small/);
  assert.match(decodeImage(Buffer.alloc(1_600_000, 0xff).toString('base64'), 'image/jpeg').error, /too large/);
  assert.equal(parseDiagnosis('sure! ' + dx({ severity: 'nuclear', confidence: 7 }) + ' done').severity, 'routine');
  assert.equal(parseDiagnosis(dx({ confidence: 7 })).confidence, 1);
  assert.equal(parseDiagnosis('no json here'), null);
});

test('MCP: fixwise_diagnose_photo sends the image to Nova Lite, then runs safety, quotes and the diagnosis card; image never stored', async () => {
  const seen = []; const env = await makeEnv({ VISION: vision(dx(), seen) });
  const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  const tools = (await c.rpc('tools/list')).result.tools;
  assert.equal(tools.find((t) => t.name === 'fixwise_diagnose_photo')._meta.ui.resourceUri, 'ui://fixwise/diagnosis');
  const r = await c.tool('fixwise_diagnose_photo', { image_base64: JPEG, media_type: 'image/jpeg', note: 'in the roof' });
  assert.equal(seen[0].messages[0].content[0].image.format, 'jpeg'); assert.ok(Buffer.isBuffer(seen[0].messages[0].content[0].image.source.bytes));
  assert.match(r.content[0].text, /^From your photo, it looks like water is dripping/);
  assert.match(r.content[0].text, /Switch the geyser off/);
  assert.equal(r.structuredContent.diagnosis.stored, false); assert.equal(r.structuredContent.issue.home.title, 'Geyser leak or failure');
  assert.equal(r._meta.ui.resourceUri, 'ui://fixwise/diagnosis');
  const dump = JSON.stringify([...env.KV.m.values()]); assert.ok(!dump.includes(JPEG.slice(0, 40)), 'image bytes must not be persisted');
  const bad = await c.tool('fixwise_diagnose_photo', { image_base64: JPEG, media_type: 'image/gif' }); assert.equal(bad.isError, true);
});

test('unsure or non-repair photos ask for words instead of guessing; model failure degrades politely', async () => {
  const env = await makeEnv({ VISION: vision(dx({ confidence: 0.2 })) });
  const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  const r = await c.tool('fixwise_diagnose_photo', { image_base64: JPEG, media_type: 'image/jpeg' });
  assert.equal(r.structuredContent.needsWords, true); assert.match(r.content[0].text, /not sure enough/);
  env.VISION = { converse: async () => { throw new Error('ThrottlingException'); } };
  const f = await c.tool('fixwise_diagnose_photo', { image_base64: JPEG, media_type: 'image/jpeg' });
  assert.equal(f.isError, true); assert.match(f.content[0].text, /few words/);
});

test('photo hazards reach safety triage: exposed wires become an emergency', async () => {
  const env = await makeEnv({ VISION: vision(dx({ item: 'distribution board', problem: 'Scorched breaker with an exposed wire.', hazards: ['exposed wire', 'sparking'], trade: 'electrical', severity: 'emergency', description: 'the distribution board has a burnt breaker and the power keeps tripping' })) });
  const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  const r = await c.tool('fixwise_diagnose_photo', { image_base64: JPEG, media_type: 'image/jpeg' });
  assert.equal(r.structuredContent.issue.safety.level, 'emergency'); assert.match(r.content[0].text, /10177|112/);
});

test('console photo endpoint calls the live MCP tool and returns the diagnosis card; per-user photo cap', async () => {
  const env = await makeEnv({ VISION: vision(dx()) }); const sid = newSessionFor('photoconsolesession0001');
  const post = async () => (await call(env, '/console/api/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, image_base64: JPEG, media_type: 'image/jpeg' }) })).json();
  const r = await post();
  assert.equal(r.card.uri, 'ui://fixwise/diagnosis'); assert.equal(r.planner, 'nova-lite-vision'); assert.equal(r.calls[0].transport, 'mcp-http');
  assert.match(r.calls[0].args.image_base64, /KB>$/, 'trace must not echo the image');
  const card = await call(env, '/console/card?uri=ui://fixwise/diagnosis'); assert.equal(card.status, 200);
  assert.match(card.headers.get('content-security-policy'), /script-src 'sha256-/);
  const bad = await call(env, '/console/api/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: 'forged', image_base64: JPEG, media_type: 'image/jpeg' }) });
  assert.equal(bad.status, 400);
});

test('Polly voice: neural Ayanda en-ZA, cached by text hash, capped and session-bound', async () => {
  const calls = []; const env = await makeEnv({ POLLY: { synth: async (i) => { calls.push(i); return Buffer.from('ID3fakeaudio'); } } });
  const sid = newSessionFor('voicesession00000000001');
  const speak = (text, s = sid) => call(env, '/console/api/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: s, text }) });
  const a = await speak('First: switch the geyser off at the board.');
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'audio/mpeg'); assert.equal(a.headers.get('x-fixwise-cache'), 'miss');
  assert.deepEqual([calls[0].Engine, calls[0].VoiceId, calls[0].LanguageCode], ['neural', 'Ayanda', 'en-ZA']);
  const b = await speak('First: switch the geyser off at the board.'); assert.equal(b.headers.get('x-fixwise-cache'), 'hit'); assert.equal(calls.length, 1);
  await speak('x'.repeat(5000)); assert.equal(calls[1].Text.length, 600);
  assert.equal((await speak('hi', 'forged')).status, 400);
  env.POLLY = { synth: async () => { throw new Error('down'); } }; assert.equal((await speak('a new line')).status, 503);
});

test('stray mic sounds and "can you hear me" get a short warm reply with no model call', async () => {
  let n = 0; const env = await makeEnv({ CONSOLE_MODEL_ID: 'us.amazon.nova-lite-v1:0', BEDROCK: { converse: async () => { n++; return { output: { message: { content: [{ text: 'x' }] } } }; } } });
  const sid = newSessionFor('fillersession000000001');
  const say = async (text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json();
  const a = await say('so'); assert.match(a.speech, /^Sorry, I only caught "so"\. What needs fixing\?$/);
  const b = await say('hello can you hear me'); assert.match(b.speech, /^Yes, I can hear you!/);
  assert.equal(n, 0);
});
