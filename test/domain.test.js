import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPublic, appendChain, verifyChain } from '../src/domain/civic.js';
import { classifyHome, priceQuotes } from '../src/domain/quotes.js';
import { triage } from '../src/domain/safety.js';
import { localAdvice } from '../src/worker/advise.js';

test('CivicOps classifier codes exist in the copied catalogue', () => {
  assert.equal(classifyPublic('live wire down').code, 'ELEC.LIVE_WIRE_DOWN');
  assert.equal(classifyPublic('big pothole on the road').code, 'ROADS.POTHOLE_REPAIR');
  assert.equal(classifyPublic('my geyser is leaking'), null, 'private repair is not a municipal case');
});
test('VAT is added once, in cents', () => {
  const q = priceQuotes(classifyHome('geyser burst'));
  for (const x of q) { assert.equal(x.subtotalCents, x.lines.reduce((a, l) => a + l.totalCents, 0)); assert.equal(x.vatCents, Math.round(x.subtotalCents * 0.15)); }
});
test('avoid supplier preference removes it', () => {
  const q = priceQuotes(classifyHome('geyser burst'), { prefs: { avoidSuppliers: ['sup-budget'] } });
  assert.ok(!q.some((x) => x.supplierId === 'sup-budget'));
});
test('tampering breaks the audit chain', async () => {
  const c = []; await appendChain(c, { at: 't', actor: 'a', action: 'x', detail: '1' }); await appendChain(c, { at: 't', actor: 'a', action: 'y', detail: '2' });
  assert.equal((await verifyChain(c)).ok, true); c[0].detail = 'changed'; assert.deepEqual(await verifyChain(c), { ok: false, brokenAt: 1 });
});
test('gas smell is an emergency', () => { assert.equal(triage('I can smell gas in the kitchen').level, 'emergency'); });
test('local advice is always available', () => { assert.ok(localAdvice({ home: { code: 'HOME.GEYSER' } }).text.length > 20); });
test('home job priority: root cause over symptom', () => {
  assert.equal(classifyHome('roof is leaking').code, 'HOME.ROOF');
  assert.equal(classifyHome('blocked drain in the yard').code, 'HOME.DRAIN');
  assert.equal(classifyHome('kitchen tap leak').code, 'HOME.PIPE_LEAK');
  assert.equal(classifyHome('geyser leaking through the ceiling').code, 'HOME.GEYSER');
});
