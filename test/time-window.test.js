import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp/tools.js';
test('book_repair accepts a requested time window', () => {
  const t = (TOOLS || []).find((x) => x.name === 'fixwise_book_repair');
  assert.ok(t.inputSchema.properties.time_window);
});
import * as I from '../src/console/intents.js';
test('fallback parses tomorrow morning', () => {
  const r = I.route('book the first plumber for tomorrow morning', {});
  assert.equal(r.tool, 'fixwise_book_repair'); assert.equal(r.args.time_window, 'tomorrow morning');
});
