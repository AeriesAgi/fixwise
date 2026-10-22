import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient, newSessionFor } from './helpers.js';
import { classifyPublic, simulatedStage } from '../src/domain/civic.js';

test('electricity and water failures route to the right department', () => {
  const c = (d, s) => classifyPublic(d, s);
  assert.equal(c('no power in the whole street').code, 'ELEC.AREA_OUTAGE'); assert.equal(c('no power in the whole street').department, 'Electricity and Energy');
  assert.equal(c('no water in the whole suburb').code, 'WATER.NO_SUPPLY'); assert.equal(c('no water in the whole suburb').department, 'Water and Sanitation');
  assert.equal(c('raw sewage running down the road').code, 'SEW.OVERFLOW');
  assert.equal(c('cable theft on our street').code, 'ELEC.CABLE_THEFT');
  assert.equal(c('a power line is down on the corner').code, 'ELEC.LIVE_WIRE_DOWN');
  assert.equal(c('the mini-sub blew').code, 'ELEC.SUBSTATION_TRIP');
  assert.equal(c('low water pressure').code, 'WATER.LOW_PRESSURE');
  assert.equal(c('the water meter is leaking').code, 'WATER.METER_LEAK');
  assert.equal(c('the power is off').scope, 'ASK.POWER'); assert.equal(c('no water since this morning').scope, 'ASK.WATER');
  assert.equal(c('power is off but the neighbours have power').scope, 'HOUSE.POWER');
  assert.equal(c('the power is off', 'area').code, 'ELEC.AREA_OUTAGE');
  assert.equal(c('pothole on 4th Avenue').code, 'ROADS.POTHOLE_REPAIR');
});

test('MCP: "no power" asks one question, then logs an area outage or quotes an electrician', async () => {
  const env = await makeEnv(); const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  const q = await c.tool('fixwise_report_problem', { description: 'the power is off' });
  assert.equal(q.structuredContent.needsScope, true); assert.match(q.content[0].text, /neighbours off too/);
  const a = await c.tool('fixwise_report_problem', { description: 'the power is off', scope: 'area', area: 'Melville' });
  assert.equal(a.structuredContent.issue.case.department, 'Electricity and Energy'); assert.match(a.content[0].text, /surge/); assert.doesNotMatch(a.content[0].text, /If only your house/);
  const h = await c.tool('fixwise_report_problem', { description: 'the power is off', scope: 'household' });
  assert.equal(h.structuredContent.issue.home.trade, 'electrical'); assert.equal(h.structuredContent.issue.case, null);
  const s = await c.tool('fixwise_report_problem', { description: 'raw sewage in the road', area: 'Melville' });
  assert.equal(s.structuredContent.issue.case.priority, 'High'); assert.match(s.content[0].text, /children and pets/);
});

test('simulated feed: utility cases stall at Acknowledged until escalated', () => {
  const t0 = 0; const c = { createdMs: t0, utility: true };
  assert.equal(simulatedStage(c, t0 + 60 * 60000, 3).stage, 'Acknowledged');
  c.escalatedMs = t0 + 60 * 60000; assert.equal(simulatedStage(c, t0 + 60 * 60000, 3).stage, 'Crew assigned');
  assert.equal(simulatedStage({ createdMs: 0 }, 60 * 60000, 3).stage, 'Resolved');
});

test('console: the neighbours answer is decided in code and logs the outage', async () => {
  const env = await makeEnv(); const sid = newSessionFor('utilityconsolesession1');
  const say = async (text) => (await call(env, '/console/api/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, text }) })).json();
  const a = await say('the power is off'); assert.match(a.speech, /neighbours off too/);
  const b = await say('yes, the whole street is off'); assert.equal(b.planner, 'scope-guard'); assert.match(b.speech, /unplanned power outage/);
});

test('planner may not guess the outage scope the customer did not state', async () => {
  const { sanitize } = await import('../src/console/planner.js');
  const tools = [{ name: 'fixwise_report_problem' }];
  assert.equal(sanitize([{ name: 'fixwise_report_problem', input: { description: 'the power is off', scope: 'area' } }], tools, 'the power is off')[0].args.scope, undefined);
  assert.equal(sanitize([{ name: 'fixwise_report_problem', input: { description: 'no power', scope: 'area' } }], tools, 'no power in the whole street')[0].args.scope, 'area');
});
