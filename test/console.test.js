import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, newSessionFor } from './helpers.js';
import { route } from '../src/console/intents.js';

const S = (k) => newSessionFor(k);
const say = async (env, sid, text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json();

test('intent routing covers the demo story', () => {
  assert.equal(route('the geyser is leaking').tool, 'fixwise_report_problem');
  assert.equal(route('compare the quotes').tool, 'fixwise_compare_quotes');
  assert.deepEqual(route('book the second one').args, { rank: 2 });
  assert.deepEqual(route('book the cheapest').args, { pick: 'cheapest' });
  assert.deepEqual(route('yes please', { pendingApproval: 'AP-1' }).args, { approval_id: 'AP-1', confirm: true });
  assert.deepEqual(route('no not yet', { pendingApproval: 'AP-1' }).args, { approval_id: 'AP-1', confirm: false });
  assert.deepEqual(route('remember our budget is 2 500 rand').args, { budget_cap_rand: 2500 });
  assert.equal(route('remember the stopcock is behind the garage').args.note, 'the stopcock is behind the garage');
  assert.equal(route('any news on the geyser?').tool, 'fixwise_check_status');
  assert.ok(route('hello').help);
});

test('console end to end: report, compare, hold, yes, status, with cards', async () => {
  const env = await makeEnv(); const sid = S('consoletestsession0001');
  const a = await say(env, sid, "The geyser's leaking and the street light outside is out");
  assert.equal(a.card.uri, 'ui://fixwise/issue'); assert.match(a.speech, /^First:/);
  const b = await say(env, sid, 'compare the quotes'); assert.equal(b.card.uri, 'ui://fixwise/quotes');
  const c = await say(env, sid, 'book the first one'); assert.equal(c.awaitingYes, true); assert.equal(c.card.uri, 'ui://fixwise/approval');
  const d = await say(env, sid, 'yes book it'); assert.match(d.speech, /^Booked\./); assert.equal(d.awaitingYes, false);
  const e = await say(env, sid, 'any news on the geyser'); assert.match(e.speech, /booked/);
  const other = await say(env, S('anothersession000000002'), "what's open"); assert.match(other.speech, /Nothing open/);
});

test('console page, cards and bad sessions', async () => {
  const env = await makeEnv();
  const p = await call(env, '/console'); assert.equal(p.status, 200); assert.match(await p.text(), /Simulated Alexa\+ experience/);
  const c = await call(env, '/console/card?uri=ui://fixwise/quotes'); assert.equal(c.status, 200);
  assert.equal((await say(env, 'x', 'hi')).error, 'bad_session');
  const off = await call(await makeEnv({ CONSOLE_ENABLED: '0' }), '/console'); assert.equal(off.status, 404);
});

test('status after booking says booked, even when the geyser was reported twice', async () => {
  const env = await makeEnv(); const sid = S('consoletestsession0002');
  await say(env, sid, 'The geyser is leaking through the ceiling');
  await say(env, sid, 'Book the first one'); const ok = await say(env, sid, 'Yes, book it');
  assert.match(ok.speech, /Booked/); assert.equal(ok.card.uri, 'ui://fixwise/approval');
  const s1 = await say(env, sid, 'Any news on the geyser?'); assert.match(s1.speech, /is booked/); assert.doesNotMatch(s1.speech, /isn't booked/);
  await say(env, sid, 'The geyser is still dripping a bit');
  const s2 = await say(env, sid, 'Any news on the geyser?'); assert.match(s2.speech, /is booked/);
});

test('status after booking the demo sentence (geyser + street light) says booked', async () => {
  const env = await makeEnv(); const sid = S('consoletestsession0003');
  await say(env, sid, "The geyser's leaking through the ceiling and the street light outside has been out for two days");
  await say(env, sid, 'Book the first one'); await say(env, sid, 'Yes, book it');
  const r = await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text: 'Any news on the geyser?' }) }).then((x) => x.json());
  assert.match(r.speech, /is booked/); assert.doesNotMatch(r.speech, /isn't booked/);
});
