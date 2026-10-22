// Local server: node src/node-server.js  (PORT, env from .dev.vars if present)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { handle } from './app.js';
import { MemoryKV } from './store/kv.js';
import { localAdvice } from './worker/advise.js';
import { loadHousehold, putAdvice } from './domain/fixwise.js';

if (existsSync('.dev.vars')) for (const l of readFileSync('.dev.vars', 'utf8').split('\n')) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const env = { ...process.env, KV: new MemoryKV() };
const port = Number(process.env.PORT || 8787);
env.PUBLIC_ORIGIN = env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;

const ctx = { enqueue: async (job) => { setTimeout(async () => {
  const h = await loadHousehold(env, job.sub); const i = h.s.issues.find((x) => x.id === job.issueId); if (!i) return;
  await putAdvice(env, job.sub, job.issueId, localAdvice(i));
}, Number(process.env.ADVICE_DELAY_MS || 1500)); } };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const t0 = performance.now();
  const out = await handle(r, env, ctx);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
  if (process.env.LOG_REQUESTS === '1') console.log(`${req.method} ${req.url.split('?')[0]} ${out.status} ${(performance.now() - t0).toFixed(1)}ms`);
}).listen(port, '127.0.0.1', () => console.log(`Fixwise MCP on http://127.0.0.1:${port}/mcp`));
