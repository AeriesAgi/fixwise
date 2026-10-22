import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleScript } from '../src/console/page.js';
import { RESOURCES } from '../src/ui/cards.js';
test('console app.js and every card script parse (guards against unescaped quotes in template literals)', () => {
  assert.doesNotThrow(() => new Function(consoleScript()));
  for (const r of RESOURCES) for (const m of String(r.text || '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]), r.uri);
});
