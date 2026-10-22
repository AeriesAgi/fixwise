import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient, newSessionFor } from './helpers.js';

const STORY = "The geyser's leaking through the ceiling and the street light outside has been out for two days";

test('status about the street light answers only about the street light (no geyser quote or advice)', async () => {
  const env = await makeEnv(); const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  await c.tool('fixwise_report_problem', { description: STORY, area: 'Melville' });
  const s = await c.tool('fixwise_check_status', { issue: 'street light' });
  assert.match(s.content[0].text, /Municipal case CO \d+/); assert.doesNotMatch(s.content[0].text, /geyser|quote|rand|plumb/i);
  assert.equal(s.structuredContent.issue.home, null); assert.equal(s.structuredContent.focus, 'case');
  const g = await c.tool('fixwise_check_status', { issue: 'geyser' });
  assert.match(g.content[0].text, /geyser/i); assert.doesNotMatch(g.content[0].text, /Municipal case/);
});

test('quotes asked for a municipal issue map to the issue that has quotes, labelled honestly', async () => {
  const env = await makeEnv(); const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  await c.tool('fixwise_report_problem', { description: STORY, area: 'Melville' });
  const q = await c.tool('fixwise_compare_quotes', { issue: 'street light' });
  assert.match(q.content[0].text, /^The streetlight fault is municipal, so no quotes\. For the geyser leak:/);
  const only = await (async () => { const e2 = await makeEnv(); const t2 = (await link(e2)).tok; const c2 = mcpClient(e2, t2.access_token);
    await c2.tool('fixwise_report_problem', { description: 'pothole on 4th Avenue', area: 'Melville' }); return c2.tool('fixwise_compare_quotes', { issue: 'pothole' }); })();
  assert.match(only.content[0].text, /municipal work, so there's nothing to quote/);
});

test('voice rule: report replies stay short; "show me" re-shows the latest card; rambling model text is replaced', async () => {
  const env = await makeEnv(); const sid = newSessionFor('voicepolishsession0001');
  const say = async (text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json();
  const a = await say(STORY + ' in Melville'); assert.ok(a.speech.split(/\s+/).length <= 40, a.speech);
  const st = await say('Any news on the street light?'); assert.doesNotMatch(st.speech, /geyser/i);
  const b = await say('okay show me the thing'); assert.equal(b.planner, 'show-guard'); assert.equal(b.card.uri, 'ui://fixwise/quotes');
  assert.ok(b.card.data.quotes.length >= 2); assert.match(b.speech, /R\d{1,3}(,\d{3})+/); assert.doesNotMatch(b.speech, /municipal|R\d \d{3}/);
  const again = await say('show me again'); assert.equal(again.card.uri, 'ui://fixwise/quotes');
  const env2 = await makeEnv({ BEDROCK: { converse: async () => ({ output: { message: { content: [{ text: 'WhatsApp is a messaging app owned by Meta. '.repeat(6) }] } } }) } });
  const r = await (await call(env2, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: newSessionFor('voicepolishsession0002'), text: 'WhatsApp' }) })).json();
  assert.match(r.speech, /^That's outside what Fixwise does\. I handle repairs at home and on your street/);
});
