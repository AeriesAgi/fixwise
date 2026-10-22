import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, link, mcpClient } from './helpers.js';
import { visitWindow, buildIcs } from '../src/domain/calendar.js';

const T = Date.UTC(2026, 9, 22, 13, 0); // Thu 22 Oct 2026, 15:00 SAST

const at = (iso) => Date.parse(iso); // helper: an instant
const sast = (w) => [w.start, w.end].map((x) => { const d = new Date(Date.parse(x) + 2 * 3600e3); return d.getUTCDay() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }).join('-');

test('visit windows are realistic trade hours (07:00-17:00 Mon-Sat SAST), never evenings or Sundays', () => {
  // Thu 22 Oct 2026 10:00 SAST, urgent: same day, starts within 30 min
  assert.equal(sast(visitWindow('today, within about 3 hours', at('2026-10-22T08:00:00Z'))), '4 10:30-4 13:30');
  // Thu 14:20 SAST, urgent: still same day, ends by 17:00
  assert.equal(sast(visitWindow('today, within about 3 hours', at('2026-10-22T12:20:00Z'))), '4 15:00-4 17:00');
  // Thu 18:15 SAST, urgent: too late, next working morning
  assert.equal(sast(visitWindow('today, within about 3 hours', at('2026-10-22T16:15:00Z'))), '5 07:00-5 12:00');
  // Sat 16:00 urgent -> Monday morning (Sunday skipped)
  assert.equal(sast(visitWindow('today, within about 2 hours', at('2026-10-24T14:00:00Z'))), '1 07:00-1 12:00');
  // Sunday 09:00 urgent -> Monday
  assert.equal(sast(visitWindow('asap', at('2026-10-25T07:00:00Z'))), '1 07:00-1 12:00');
  // early morning urgent starts at opening
  assert.equal(sast(visitWindow('today', at('2026-10-22T03:00:00Z'))), '4 07:00-4 10:00');
  assert.equal(sast(visitWindow('tomorrow morning', at('2026-10-22T13:00:00Z'))), '5 07:00-5 12:00');
  assert.equal(sast(visitWindow('Saturday evening', at('2026-10-22T13:00:00Z'))), '6 12:00-6 17:00');
  assert.equal(sast(visitWindow('Sunday', at('2026-10-22T13:00:00Z'))), '1 07:00-1 12:00');
  for (let h = 0; h < 24 * 8; h += 1) for (const sl of ['today, within about 3 hours', 'tomorrow', 'within two days', 'friday evening']) {
    const w = visitWindow(sl, at('2026-10-19T00:00:00Z') + h * 3600e3); const [a, b] = sast(w).split('-');
    assert.ok(a[0] !== '0' && a.slice(2) >= '07:00' && b.slice(2) <= '17:00' && Date.parse(w.start) > at('2026-10-19T00:00:00Z') + h * 3600e3, `${sl} @${h}: ${sast(w)}`);
  }
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
