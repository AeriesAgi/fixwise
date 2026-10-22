// Builds .deploy/cf-worker-upload.js (contains the origin secret; delete after use) for the Cloudflare API upload of infra/worker/proxy.js.
// Run from the repo root: node scripts/cf-worker-upload.cjs
const fs = require('fs');
const code = fs.readFileSync('infra/worker/proxy.js', 'utf8');
const origin = require(require('path').join(__dirname, '..', '.deploy', 'outputs.json')).Fixwise.McpUrl.replace(/mcp$/, '');
const secret = fs.readFileSync('.deploy/origin_secret', 'utf8').trim();
const metadata = { main_module: 'worker.js', compatibility_date: '2026-10-01', bindings: [
  { type: 'plain_text', name: 'ORIGIN_URL', text: origin },
  { type: 'secret_text', name: 'ORIGIN_SECRET', text: secret },
  { type: 'ratelimit', name: 'RL', namespace_id: '1001', simple: { limit: 30, period: 60 } }] };
const fn = `async () => {
  const code = ${JSON.stringify(code)};
  const metadata = ${JSON.stringify(metadata)};
  const b = 'F' + Date.now();
  const body = ['--' + b, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), '--' + b, 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"', 'Content-Type: application/javascript+module', '', code, '--' + b + '--'].join('\\r\\n');
  const r = await cloudflare.request({ method: 'PUT', path: '/accounts/' + accountId + '/workers/scripts/fixwise-alexa-proxy', body, contentType: 'multipart/form-data; boundary=' + b, rawBody: true });
  return { success: r.success, errors: r.errors, bindings: ((r.result && r.result.bindings) || []).map((x) => x.name + ':' + x.type) };
}`;
fs.writeFileSync('.deploy/cf-worker-upload.js', fn);
new Function('cloudflare', 'accountId', 'return (' + fn + ')'); // syntax check only
console.log('built');
