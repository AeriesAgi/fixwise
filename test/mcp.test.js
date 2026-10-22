import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient } from './helpers.js';

async function session(extra) { const env = await makeEnv(extra); const { tok } = await link(env); const jobs = []; return { env, jobs, c: mcpClient(env, tok.access_token, { enqueue: async (j) => jobs.push(j) }), tok }; }

test('initialize negotiates 2025-11-25 and lists tools with MCP Apps UI links', async () => {
  const { c } = await session();
  const init = await c.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const tools = (await c.rpc('tools/list')).result.tools;
  assert.ok(tools.length >= 10);
  assert.equal(tools.find((t) => t.name === 'fixwise_compare_quotes')._meta.ui.resourceUri, 'ui://fixwise/quotes');
  const res = (await c.rpc('resources/list')).result.resources;
  assert.ok(res.every((r) => r.mimeType === 'text/html;profile=mcp-app'));
  const card = (await c.rpc('resources/read', { uri: 'ui://fixwise/quotes' })).result.contents[0];
  assert.match(card.text, /ui\/notifications\/tool-result/);
});

test('unsupported MCP-Protocol-Version header is 400; batch is rejected; notifications get 202', async () => {
  const { env, tok } = await session();
  const h = { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };
  assert.equal((await call(env, '/mcp', { method: 'POST', headers: { ...h, 'mcp-protocol-version': '1999-01-01' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 400);
  assert.equal((await call(env, '/mcp', { method: 'POST', headers: h, body: '[{"jsonrpc":"2.0","id":1,"method":"ping"}]' })).status, 400);
  assert.equal((await call(env, '/mcp', { method: 'POST', headers: h, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })).status, 202);
  assert.equal((await call(env, '/mcp', { method: 'GET', headers: h })).status, 405);
  assert.equal((await call(env, '/mcp', { method: 'POST', headers: { ...h, origin: 'https://evil.example' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 403);
});

test('geyser + dark street: safety first, municipal case, quotes, async advice job', async () => {
  const { c, jobs } = await session();
  const r = await c.tool('fixwise_report_problem', { description: "The geyser's leaking through the ceiling and the street light outside has been out for two days", area: 'Melville' });
  const text = r.content[0].text;
  assert.match(text, /^First: Switch the geyser off/);
  assert.match(text, /Electricity|logged/i);
  const i = r.structuredContent.issue;
  assert.equal(i.case.department.length > 0, true); assert.equal(i.case.simulated, true);
  assert.equal(i.home.title, 'Geyser leak or failure');
  assert.ok(i.home.quotes.length >= 2);
  assert.ok(!i.home.quotes.some((q) => /Suspended/.test(q.supplier)));
  assert.equal(jobs.length, 1); assert.equal(jobs[0].issueId, i.id); assert.ok(jobs[0].sub);
  assert.equal(r._meta.ui.resourceUri, 'ui://fixwise/issue');
});

test('emergency wording comes first for a live wire', async () => {
  const { c } = await session();
  const r = await c.tool('fixwise_report_problem', { description: 'There is a live wire sparking on the pavement' });
  assert.match(r.content[0].text, /^If anyone is in danger, call 112/);
  assert.equal(r.structuredContent.issue.case.priority, 'Urgent');
});

test('booking is two-step, bound to the held quote, single use', async () => {
  const { c } = await session();
  await c.tool('fixwise_report_problem', { description: 'burst pipe under the kitchen sink' });
  const hold = await c.tool('fixwise_book_repair', { rank: 1 });
  assert.match(hold.content[0].text, /Shall I book it\?/);
  const id = hold.structuredContent.approval.id;
  const st1 = await c.tool('fixwise_check_status', {});
  assert.equal(st1.structuredContent.issue.booking, null, 'nothing booked before yes');
  const ok = await c.tool('fixwise_book_repair', { approval_id: id, confirm: true });
  assert.match(ok.content[0].text, /^Booked\./);
  const again = await c.tool('fixwise_book_repair', { approval_id: id, confirm: true });
  assert.match(again.content[0].text, /already booked/);
});

test('declining books nothing; budget cap is respected', async () => {
  const { c } = await session();
  await c.tool('fixwise_remember', { budget_cap_rand: 500 });
  await c.tool('fixwise_report_problem', { description: 'my geyser is leaking' });
  const hold = await c.tool('fixwise_book_repair', { rank: 1 });
  assert.equal(hold.structuredContent.overBudget, true);
  const h2 = await c.tool('fixwise_book_repair', { rank: 1, over_budget_ok: true });
  const no = await c.tool('fixwise_book_repair', { approval_id: h2.structuredContent.approval.id, confirm: false });
  assert.match(no.content[0].text, /not booked/);
});

test('state persists across sessions (new token, same household) and duplicates link', async () => {
  const env = await makeEnv();
  const a = mcpClient(env, (await link(env)).tok.access_token);
  const first = await a.tool('fixwise_report_problem', { description: 'street light outside number 12 is out', area: 'Melville' });
  const b = mcpClient(env, (await link(env)).tok.access_token);
  const st = await b.tool('fixwise_check_status', { issue: first.structuredContent.issue.case.reference });
  assert.equal(st.structuredContent.issue.id, first.structuredContent.issue.id);
  const dup = await b.tool('fixwise_report_problem', { description: 'the street light outside number 12 is still out', area: 'Melville' });
  assert.match(dup.content[0].text, /already logged/);
});

test('households are isolated', async () => {
  const env = await makeEnv();
  const a = mcpClient(env, (await link(env, { email: 'a@example.test' })).tok.access_token);
  const b = mcpClient(env, (await link(env, { email: 'b@example.test' })).tok.access_token);
  await a.tool('fixwise_report_problem', { description: 'pothole on our road' });
  const lb = await b.tool('fixwise_list_issues');
  assert.equal(lb.structuredContent.issues.length, 0);
});

test('read-only scope cannot act; audit chain verifies; disconnect revokes', async () => {
  const env = await makeEnv();
  const ro = mcpClient(env, (await link(env, { scope: 'fixwise.read' })).tok.access_token);
  const denied = await ro.rpc('tools/call', { name: 'fixwise_report_problem', arguments: { description: 'pothole here' } });
  assert.equal(denied.error.code, -32003);
  const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  await c.tool('fixwise_report_problem', { description: 'pothole on Main Road' });
  await c.tool('fixwise_remember', { note: 'The stopcock is behind the garage' });
  const act = await c.tool('fixwise_activity');
  assert.equal(act.structuredContent.verify.ok, true); assert.equal(act.structuredContent.verify.length, 2);
  const rec = await c.tool('fixwise_recall', { query: 'where is the stopcock' });
  assert.match(rec.content[0].text, /behind the garage/);
  await c.tool('fixwise_disconnect');
  const after = await call(env, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(after.status, 401);
});

test('invalid arguments are reported, unknown tool is an error', async () => {
  const { c } = await session();
  const bad = await c.tool('fixwise_report_problem', { description: 'x'.repeat(2000) });
  assert.equal(bad.isError, true);
  const unk = await c.rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unk.error.code, -32602);
});
