import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, newSessionFor } from './helpers.js';
import { sanitize, toBedrockTools } from '../src/console/planner.js';
import { publicTools } from '../src/mcp/tools.js';
import { classifyHomeAll } from '../src/domain/quotes.js';
import { extractArea } from '../src/domain/fixwise.js';

const S = (k) => newSessionFor(k);
const say = async (env, sid, text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json();
const fake = (fn) => ({ converse: async (input) => fn(input) });
const use = (...calls) => ({ output: { message: { content: calls.map(([name, input]) => ({ toolUse: { toolUseId: 't' + name, name, input } })) } } });

test('Nova plan is executed over MCP HTTP and traced', async () => {
  let seen; const env = await makeEnv({ BEDROCK: fake((i) => { seen = i; return use(['fixwise_report_problem', { description: 'the fridge is buzzing and the tap drips' }]); }) });
  const r = await say(env, S('plannertestsession0001'), 'the fridge is buzzing and the tap drips');
  assert.equal(r.planner, 'nova-lite'); assert.equal(r.calls[0].transport, 'mcp-http');
  assert.match(r.speech, /split that into 2 repairs/); assert.match(r.speech, /fridge/i); assert.match(r.speech, /tap/i);
  assert.equal(seen.modelId, 'us.amazon.nova-lite-v1:0');
  assert.ok(seen.toolConfig.tools.length === 10 && !seen.toolConfig.tools.some((t) => t.toolSpec.name === 'fixwise_disconnect'));
});

test('model cannot confirm a booking; yes/no goes through the code guard', async () => {
  const env = await makeEnv({ BEDROCK: fake(() => use(['fixwise_report_problem', { description: 'geyser leaking' }])) });
  const sid = S('plannertestsession0002');
  await say(env, sid, 'the geyser is leaking');
  env.BEDROCK = fake(() => use(['fixwise_book_repair', { rank: 1, confirm: true, approval_id: 'AP-FAKE' }]));
  const hold = await say(env, sid, 'book the first one'); assert.equal(hold.awaitingYes, true); assert.deepEqual(hold.calls[0].args, { rank: 1 });
  env.BEDROCK = fake(() => { throw new Error('must not be called'); });
  const yes = await say(env, sid, 'yes please'); assert.equal(yes.planner, 'confirmation-guard'); assert.match(yes.speech, /^Booked\./);
});

test('falls back to the regex router when Bedrock fails or times out', async () => {
  const env = await makeEnv({ BEDROCK: fake(() => { throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); }) });
  const r = await say(env, S('plannertestsession0003'), 'compare the quotes');
  assert.equal(r.planner, 'regex'); assert.equal(r.fallbackReason, 'ThrottlingException'); assert.equal(r.calls[0].tool, 'fixwise_compare_quotes');
  const slow = await makeEnv({ PLANNER_TIMEOUT_MS: '30', BEDROCK: { converse: (i, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } });
  const s = await say(slow, S('plannertestsession0004'), 'the geyser is leaking'); assert.equal(s.fallbackReason, 'AbortError'); assert.match(s.speech, /geyser/);
});

test('guard rejects an overreaching side effect and merges duplicate reports', () => {
  const tools = publicTools();
  assert.equal(sanitize([{ name: 'fixwise_book_repair', input: { rank: 1 } }], tools, 'the street light is out'), null);
  const m = sanitize([{ name: 'fixwise_report_problem', input: { description: 'fridge buzzing' } }, { name: 'fixwise_report_problem', input: { description: 'tap drips' } }], tools, 'fridge buzzing and the tap drips');
  assert.equal(sanitize([{ name: 'fixwise_report_problem', input: { description: 'street light out', area: 'Street' } }], tools, 'The street light outside is out')[0].args.area, undefined);
  assert.equal(sanitize([{ name: 'fixwise_report_problem', input: { description: 'pothole', area: 'Melville' } }], tools, 'pothole in Melville')[0].args.area, 'Melville');
  assert.equal(m.length, 1); assert.equal(m[0].args.description, 'fridge buzzing and the tap drips');
  assert.ok(!toBedrockTools(tools).find((t) => t.toolSpec.name === 'fixwise_book_repair').toolSpec.inputSchema.json.properties.confirm);
});

test('out-of-scope reply from the model and from the fallback', async () => {
  const env = await makeEnv({ BEDROCK: fake(() => ({ output: { message: { content: [{ text: 'Fixwise only handles home and street repairs. What needs fixing?' }] } } })) });
  const r = await say(env, S('plannertestsession0005'), 'play some jazz'); assert.equal(r.calls.length, 0); assert.match(r.speech, /home and street repairs/);
  const off = await makeEnv({ CONSOLE_LLM: '0' });
  const w = await say(off, S('plannertestsession0006'), "what's the weather tomorrow"); assert.match(w.speech, /outside what Fixwise does/);
  const x = await say(off, S('plannertestsession0007'), 'my cat looks sad'); assert.match(x.speech, /outside what Fixwise does/);
});

test('compound home issues, root cause wins, area asked then filled', async () => {
  assert.deepEqual(classifyHomeAll('the fridge is buzzing and the tap drips').map((j) => j.code), ['HOME.APPLIANCE', 'HOME.PIPE_LEAK']);
  assert.deepEqual(classifyHomeAll('the geyser is leaking through the ceiling').map((j) => j.code), ['HOME.GEYSER']);
  assert.equal(extractArea('the pothole on Jan Smuts Avenue is huge'), 'Jan Smuts Avenue');
  const env = await makeEnv({ CONSOLE_LLM: '0' }); const sid = S('plannertestsession0008');
  const a = await say(env, sid, 'the street light outside has been out for two days'); assert.equal(a.awaitingArea, true); assert.match(a.speech, /Which suburb or street/);
  const b = await say(env, sid, 'Parkhurst'); assert.match(b.speech, /added it to municipal case CO \d+/); assert.equal(b.awaitingArea, false);
  const c = await say(env, S('plannertestsession0009'), 'there is a pothole in Melville'); assert.equal(c.awaitingArea, false); assert.match(c.speech, /for Melville/);
});

test('memory across conversations: new conversation, same household', async () => {
  const env = await makeEnv({ CONSOLE_LLM: '0' }); const sid = S('plannertestsession0010');
  await say(env, sid, 'the geyser is leaking'); await say(env, sid, 'book the first one'); await say(env, sid, 'yes');
  const n = await call(env, '/console/api/new-conversation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid }) }); assert.equal(n.status, 200);
  const s = await say(env, sid, 'any news on my geyser?'); assert.match(s.speech, /is booked/);
});

test('late advisor note never wipes a booking made meanwhile (worker race)', async () => {
  const { worker } = await import('../src/lambda.js');
  const jobs = []; const env = await makeEnv({ CONSOLE_LLM: '0' }); const sid = S('plannertestsession0011');
  const { handle } = await import('../src/app.js'); env.MCP_FETCH = (u, i) => handle(new Request(u, i), env, { enqueue: async (j) => jobs.push(j) });
  const sayc = async (text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) }, { enqueue: async (j) => jobs.push(j) })).json();
  await sayc('the geyser is leaking'); await sayc('book the first one'); await sayc('yes');
  const { putAdvice } = await import('../src/domain/fixwise.js');
  for (const j of jobs) await putAdvice(env, j.sub, j.issueId, { text: 'Ask about a drip tray.', spoken: 'Ask about a drip tray.', source: 'test', at: new Date().toISOString() });
  const s = await sayc('any news on the geyser'); assert.match(s.speech, /is booked/); assert.match(s.speech, /drip tray/);
  assert.equal(typeof worker, 'function'); assert.ok(jobs.length >= 1);
});
