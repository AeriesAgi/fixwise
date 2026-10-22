import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call } from './helpers.js';
test('judge client script is served and is valid JS', async () => {
  const r = await call(await makeEnv(), '/judge.mjs'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  const src = await r.text(); assert.match(src, /fixwise-judge/); assert.match(src, /code_challenge_method: 'S256'/);
});
