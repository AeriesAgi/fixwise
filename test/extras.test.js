import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, newSessionFor } from './helpers.js';
import { parseRating } from '../src/domain/fixwise.js';

const sayer = (env, label) => { const sid = newSessionFor(label); return { sid, say: async (text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json() }; };

test('parseRating understands spoken ratings', () => {
  assert.deepEqual(parseRating('Yes, fixed. 5 stars'), { stars: 5, fixed: true });
  assert.deepEqual(parseRating('not fixed, two out of five'), { stars: 2, fixed: false });
  assert.deepEqual(parseRating('four'), { stars: 4, fixed: null });
});

test('after the visit, status asks "did they fix it? rate them", a low score avoids the supplier next time', async () => {
  const env = await makeEnv(); const { sid, say } = sayer(env, 'ratingflow0001');
  await say('My geyser is leaking in Melville'); await say('Book the best one'); const b = await say('Yes, book it');
  assert.match(b.speech, /^Booked\./);
  const before = await say('Any news on the geyser?'); assert.doesNotMatch(before.speech, /Rate them/);
  await call(env, '/console/api/skip-ahead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, hours: 96 }) });
  const ask = await say('Any news on the geyser?'); assert.match(ask.speech, /visit is done\. Did they fix the geyser\? Rate them 1 to 5\./); assert.equal(ask.awaitingRating, true);
  const r = await say('Not fixed, 2 stars'); assert.equal(r.planner, 'rating-guard');
  assert.match(r.speech, /2 out of 5 for AquaFix Plumbing is saved\. I won't suggest them again\. I'll keep the geyser open/);
  const q = await say('Compare the quotes'); assert.doesNotMatch(JSON.stringify(q.card?.data?.quotes || []), /AquaFix/); assert.ok(q.card.data.quotes.length >= 2);
  const rb = await say('Book the first one'); assert.match(rb.speech, /^To confirm: Demo FlowRight/);
});

test('booking carries a generic load-shedding tip (not live data); "why is it more?" explains the price and the saving', async () => {
  const env = await makeEnv(); const { say } = sayer(env, 'explainflow0001');
  await say('My geyser is leaking in Melville');
  const e = await say('Why is the first one more expensive?'); assert.equal(e.planner, 'explain-guard');
  assert.match(e.speech, /^AquaFix Plumbing costs R690 more than Budget Pipes, mostly .+\. They come in about 3 hours, not 24 and are rated 4\.8, not 3\.9\. If waiting is fine, Budget Pipes saves you R690\.$/);
  assert.ok(e.speech.split(/\s+/).length <= 40); assert.ok(e.card.data.explain.rows.length >= 3);
  await say('Book the best one'); const b = await say('Yes, book it');
  assert.match(b.card.data.booking.loadShedding.tip, /check your area's schedule/); assert.match(b.card.data.booking.loadShedding.source, /not live/);
  assert.doesNotMatch(b.speech, /load-shedding|stage/i);
});

test('Afrikaans: Nova translates in and out, the turn runs in English, honest about voice', async () => {
  const seen = [];
  const TRANSLATE = { converse: async (inp) => { const sys = inp.system[0].text; const t = inp.messages[0].content[0].text; seen.push(sys);
    return { output: { message: { content: [{ text: / to South African English/.test(sys) ? 'My geyser is leaking in Melville' : `AF: ${t}` }] } } }; } };
  const env = await makeEnv({ TRANSLATE, CONSOLE_LLM: '0' }); const sid = newSessionFor('afrikaans0001');
  const r = await (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text: 'My geiser lek in Melville', lang: 'af' }) })).json();
  assert.equal(r.heardEn, 'My geyser is leaking in Melville'); assert.match(r.speechEn, /geyser/i); assert.equal(r.speech, `AF: ${r.speechEn}`);
  assert.equal(r.lang, 'af'); assert.equal(r.translatedBy, 'Amazon Nova Lite'); assert.ok(r.card);
  assert.match(seen[0], /Afrikaans to South African English/); assert.match(seen[1], /to Afrikaans/); assert.match(seen[1], /rand amounts/);
  const bad = await (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: 'forged.x', text: 'hallo', lang: 'zu' }) })).json();
  assert.equal(bad.error, 'bad_session');
});

test('landlord view: signed read-only page with live repairs; tampered link fails; never claims to send', async () => {
  const env = await makeEnv(); const { say } = sayer(env, 'landlord0001');
  await say('My geyser is leaking in Melville');
  const r = await say('Share this with my landlord'); assert.equal(r.planner, 'landlord-guard');
  assert.match(r.speech, /read-only page for your landlord.*I can't send it for you/);
  const u = new URL(r.card.data.landlord.url); assert.equal(u.pathname, '/landlord');
  const page = await call(env, u.pathname + u.search); assert.equal(page.status, 200);
  const body = await page.text(); assert.match(body, /Geyser leak or failure/); assert.match(body, /read-only/); assert.match(body, /R2,967/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const bad = await call(env, u.pathname + u.search.replace(/s=.{3}/, 's=xxx')); assert.equal(bad.status, 404);
});
