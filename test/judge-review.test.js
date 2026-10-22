// Regressions found in the 22 Oct strict judge pass on the live console.
import test from 'node:test'; import assert from 'node:assert/strict';
import { isAvoided, classifyHomeAll, priceQuotes } from '../src/domain/quotes.js';
import { triage } from '../src/domain/safety.js';
import { route } from '../src/console/intents.js';
test('avoid matches catalogue names loosely', () => {
  assert.ok(isAvoided({ avoidSuppliers: ['Budget Pipes'] }, 'x', 'Demo Budget Pipes'));
  assert.ok(!isAvoided({ avoidSuppliers: ['Budget Pipes'] }, 'x', 'Demo AquaFix Plumbing'));
  const job = classifyHomeAll('geyser leaking')[0];
  assert.ok(priceQuotes(job, { prefs: { avoidSuppliers: ['budget pipes'] } }).every((q) => !/budget pipes/i.test(q.supplier)));
});
test('"water pouring from my geyser" gets safety steps', () => { const t = triage('There is water pouring from my geyser'); assert.equal(t.level, 'urgent'); assert.ok(t.steps.length >= 1); });
test('budget question is a recall, not a new report', () => assert.equal(route("What's my budget again?").tool, 'fixwise_recall'));
test('any news routes to status', () => assert.equal(route('Any news on the geyser?').tool, 'fixwise_check_status'));
import { sanitize } from '../src/console/planner.js';
const T = [{ name: 'fixwise_book_repair' }, { name: 'fixwise_remember' }, { name: 'fixwise_report_problem' }];
test('"book the cheapest" sets pick even if the model sends rank 1', () => assert.deepEqual(sanitize([{ name: 'fixwise_book_repair', input: { rank: 1 } }], T, 'Book the cheapest one')[0].args, { pick: 'cheapest' }));
test('model cannot re-save old preferences unasked', () => assert.deepEqual(sanitize([{ name: 'fixwise_report_problem', input: { description: 'tap dripping' } }, { name: 'fixwise_remember', input: { budget_cap_rand: 2500 } }], T, 'My kitchen tap is dripping').map((c) => c.tool), ['fixwise_report_problem']));
