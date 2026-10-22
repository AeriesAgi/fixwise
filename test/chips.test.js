import test from 'node:test'; import assert from 'node:assert';
import { topicOf, noteTopics, contextChips } from '../src/console/topics.js';
const NEXT = ['Compare the quotes', 'Book the first one', 'Any news on the street light?'];
test('no street-light chip when no street-light case exists', () => {
  assert.deepStrictEqual(contextChips(NEXT, []), ['Compare the quotes', 'Book the first one']);
  assert.deepStrictEqual(contextChips(NEXT, ['geyser']), ['Compare the quotes', 'Book the first one', 'Any news on the geyser?']);
  assert.deepStrictEqual(contextChips(['Any news on the power?'], ['power', 'geyser']), ['Any news on the power?']);
});
test('topics come from real cases in the conversation, newest first', () => {
  const d = {};
  noteTopics(d, { issue: { id: 'a', home: { title: 'Geyser leak or failure' } } });
  noteTopics(d, { issue: { id: 'b', case: { title: 'Unplanned power outage' } } });
  assert.deepStrictEqual(d.topics, ['power', 'geyser']);
  assert.strictEqual(topicOf({ case: { title: 'Street light out' } }), 'street light');
  noteTopics(d, { quotes: [] }); assert.deepStrictEqual(d.topics, ['power', 'geyser']);
});
test('console page applies the same chip rule', async () => {
  const { consoleScript } = await import('../src/console/page.js').catch(() => ({}));
  const src = String(consoleScript || (await import('node:fs')).readFileSync(new URL('../src/console/page.js', import.meta.url), 'utf8'));
  assert.match(src, /ctxChips\(NEXT\[r\.tool\]/);
});
test('demo clock note is unambiguous and skip chips are context-aware', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/console/page.js', import.meta.url), 'utf8');
  const fn = new Function(src.match(/function demoClockNote\(h,t\)\{.*?\}\n/s)[0] + 'return demoClockNote;')();
  assert.strictEqual(fn(48, 48), '⏩ Demo clock: +48 h. Real tool calls, simulated time.');
  assert.strictEqual(fn(48, 144), '⏩ Demo clock: +48 h (skip 3, so +144 h since you started). Real tool calls, simulated time.');
  assert.doesNotMatch(src, /chips\(\['Any news on the power\?'/);
});
