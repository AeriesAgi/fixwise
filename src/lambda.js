// AWS Lambda entry points. `http` serves API Gateway HTTP API (payload v2) / Function URLs; `worker` consumes SQS.
import { handle } from './app.js';
import { DynamoKV } from './store/kv.js';
import { loadHousehold, putAdvice } from './domain/fixwise.js';
import { localAdvice } from './worker/advise.js';
import { agentAdvice } from './worker/agent-client.js';

let envP;
async function getEnv() {
  envP ??= (async () => {
    const env = { ...process.env, KV: await DynamoKV.create(process.env.TABLE_NAME) };
    if (process.env.SECRETS_PARAM) {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const r = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.SECRETS_PARAM, WithDecryption: true }));
      Object.assign(env, JSON.parse(r.Parameter.Value)); // FIXWISE_CLIENTS, HOUSEHOLDS. Never logged.
    }
    if (process.env.QUEUE_URL) {
      const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
      const sqs = new SQSClient({});
      env.enqueue = (job) => sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(job) }));
    }
    return env;
  })();
  return envP;
}

export async function http(event) {
  const env = await getEnv();
  if (event.source === 'aws.events') { await env.KV.get('warm'); return { ok: true }; } // keep-warm ping
  return serve(event, env);
}

export function toRequest(event) {
  const host = event.headers?.host || event.requestContext?.domainName;
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const method = event.requestContext?.http?.method || 'GET';
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  return new Request(`https://${host}${event.rawPath || '/'}${qs}`, { method, headers: event.headers || {}, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
}

// Origin lock: only the Cloudflare Worker knows ORIGIN_SECRET and sends it as x-fixwise-origin, so the raw Function URL
// returns 403 to everyone else (that also keeps Cloudflare's rate limits from being bypassed). Fails closed in production.
import { timingSafeEqual } from './util.js';
export function originLocked(event, env) {
  if (!env.ORIGIN_SECRET) return env.ENVIRONMENT === 'production';
  const got = event.headers?.['x-fixwise-origin'] || '';
  return !timingSafeEqual(got, env.ORIGIN_SECRET);
}
export async function serve(event, env) {
  const t0 = Date.now();
  if (originLocked(event, env)) {
    console.log(JSON.stringify({ level: 'warn', msg: 'origin_rejected', path: event.rawPath }));
    return { statusCode: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"error":"forbidden"}' };
  }
  const res = await handle(toRequest(event), env, { enqueue: env.enqueue });
  const headers = Object.fromEntries(res.headers);
  console.log(JSON.stringify({ level: 'info', method: event.requestContext?.http?.method, path: event.rawPath, status: res.status, ms: Date.now() - t0 })); // no headers, bodies, query strings or tokens
  return { statusCode: res.status, headers, body: await res.text() };
}

export async function worker(event) {
  const env = await getEnv();
  for (const rec of event.Records || []) {
    const job = JSON.parse(rec.body);
    const h = await loadHousehold(env, job.sub);
    const issue = h.s.issues.find((x) => x.id === job.issueId);
    if (!issue) continue;
    let note = null;
    try { note = await agentAdvice(env, issue); } catch (e) { console.log(JSON.stringify({ level: 'warn', msg: 'agent_failed', err: String(e?.name || e).slice(0, 80) })); }
    await putAdvice(env, job.sub, job.issueId, note || localAdvice(issue)); // own key: never overwrites a booking made meanwhile
  }
}
