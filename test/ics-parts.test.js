import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient } from './helpers.js';
import { visitWindow, buildIcs } from '../src/domain/calendar.js';

const T = Date.UTC(2026, 9, 22, 13, 0); // Thu 22 Oct 2026, 15:00 SAST

test('visit windows are concrete SAST times', () => {
  assert.equal(visitWindow('tomorrow morning', T).start, '2026-10-23T06:00:00.000Z');
  assert.equal(visitWindow('tomorrow morning', T).end, '2026-10-23T10:00:00.000Z');
  const w = visitWindow('today, within about 3 hours', T); assert.equal(w.start, '2026-10-22T14:00:00.000Z'); assert.equal(w.end, '2026-10-22T16:00:00.000Z');
  assert.equal(visitWindow('Saturday afternoon', T).start, '2026-10-24T10:00:00.000Z');
  assert.match(visitWindow('tomorrow morning', T).label, /Fri.*23 Oct.*08:00–12:00 SAST/);
  const ics = buildIcs({ ref: 'BK-1', start: '2026-10-23T06:00:00.000Z', end: '2026-10-23T10:00:00.000Z', title: 'A, b; c', desc: 'x' });
  assert.match(ics, /DTSTART:20261023T060000Z\r\n/); assert.match(ics, /SUMMARY:A\\, b\\; c/); assert.match(ics, /BEGIN:VALARM/);
});

test('a place name is not a time window', async () => {
  const env = await makeEnv(); const { tok } = await link(env); const c = mcpClient(env, tok.access_token);
  await c.tool('fixwise_report_problem', { description: 'my geyser is leaking', area: 'Melville' });
  const held = await c.tool('fixwise_book_repair', { issue: 'geyser', rank: 1, time_window: 'Melville' });
  assert.doesNotMatch(held.structuredContent.approval.slot, /Melville/);
});

test('confirmed booking returns a signed .ics link that downloads, plus amazon.co.za parts search links', async () => {
  const env = await makeEnv(); const { tok } = await link(env); const c = mcpClient(env, tok.access_token, { origin: 'https://fixwise.test' });
  await c.tool('fixwise_report_problem', { description: 'my geyser is leaking', area: 'Melville' });
  const held = await c.tool('fixwise_book_repair', { issue: 'geyser', rank: 1 });
  const ok = await c.tool('fixwise_book_repair', { approval_id: held.structuredContent.approval.id, confirm: true });
  const b = ok.structuredContent.booking;
  assert.match(ok.content[0].text, /^Booked\. .+ between \d\d:\d\d and \d\d:\d\d, reference .+ calendar file and a parts list are on screen\.$/);
  assert.doesNotMatch(ok.content[0].text, /reminder|cart|order/i);
  assert.ok(b.visit.ics.startsWith('https://fixwise.test/ics?d='));
  assert.equal(b.reminder.suggested, true);
  assert.ok(b.parts.items.length >= 2); for (const p of b.parts.items) assert.match(p.url, /^https:\/\/www\.amazon\.co\.za\/s\?k=/);
  const path = b.visit.ics.replace('https://fixwise.test', '');
  const r = await call(env, path); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(await r.text(), /BEGIN:VEVENT[\s\S]*SUMMARY:.*Geyser/);
  const bad = await call(env, path.replace(/s=.{4}/, 's=AAAA')); assert.equal(bad.status, 404);
});
