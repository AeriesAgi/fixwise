import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/lambda.js';
import { makeEnv } from './helpers.js';

test('API Gateway v2 events map to the router (PRM + 401 on /mcp)', async (t) => {
  const env = await makeEnv({ PUBLIC_ORIGIN: undefined });
  const logs = []; t.mock.method(console, 'log', (m) => logs.push(m));
  const prm = await serve({ rawPath: '/.well-known/oauth-protected-resource', headers: { host: 'abc.execute-api.us-east-1.amazonaws.com' }, requestContext: { http: { method: 'GET' } } }, env);
  assert.equal(JSON.parse(prm.body).resource, 'https://abc.execute-api.us-east-1.amazonaws.com/mcp');
  const r = await serve({ rawPath: '/mcp', headers: { host: 'abc.execute-api.us-east-1.amazonaws.com', authorization: 'Bearer secret-token-should-not-be-logged-000' }, rawQueryString: 'code=shh',
    body: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}').toString('base64'), isBase64Encoded: true, requestContext: { http: { method: 'POST' } } }, env);
  assert.equal(r.statusCode, 401);
  assert.ok(!logs.join('\n').includes('secret-token') && !logs.join('\n').includes('shh'), 'no tokens or query strings in logs');
});
