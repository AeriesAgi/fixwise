import test from 'node:test'; import assert from 'node:assert';
import { cleanAdvice } from '../src/domain/fixwise.js';
test('advisor note post-filter keeps <=2 relevant sentences', () => {
  const n = cleanAdvice({ text: '<response>Check the isolator is off. Ask for a COC after the work. I hope this helps! Also consider solar.</response>', source: 'x' });
  assert.equal(n.text, 'Check the isolator is off. Ask for a COC after the work.'); assert.equal(n.spoken, 'Check the isolator is off.');
  assert.equal(cleanAdvice({ text: '' }), null);
});
