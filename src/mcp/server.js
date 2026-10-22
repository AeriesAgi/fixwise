// MCP Streamable HTTP endpoint, protocol 2025-11-25 (also accepts 2025-06-18 / 2025-03-26 clients).
// Stateless JSON responses (no SSE stream); GET/DELETE return 405 as the transport allows.
// Two mounts, same server: /mcp follows the MCP spec (401 carries WWW-Authenticate with resource_metadata);
// /alexa/mcp is the URL registered with Alexa+, whose onboarding rules require a 401 WITHOUT that header.
import { TOOLS, publicTools, validateArgs } from './tools.js';
import { RESOURCES, UI_MIME } from '../ui/cards.js';
import { bearer, revokeFamily } from '../oauth/oauth.js';
import * as fx from '../domain/fixwise.js';
import { json, sha256, now, origin, CORS } from '../util.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const RATE_PER_MIN = 60;
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const bad = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const hasScope = (g, scope) => String(g.scope || '').split(' ').includes(scope);

// Fixed one-minute window per user, counted atomically in the store.
async function overLimit(env, sub) {
  const n = await env.KV.incr(`lim:rpc:${await sha256(sub)}:${Math.floor(now() / 60)}`, 120);
  return n > RATE_PER_MIN;
}

const HANDLERS = {
  fixwise_report_problem: fx.reportProblem, fixwise_diagnose_photo: fx.diagnosePhoto, fixwise_check_status: fx.checkStatus, fixwise_escalate: fx.escalate, fixwise_list_issues: fx.listIssues,
  fixwise_compare_quotes: fx.compareQuotes, fixwise_book_repair: fx.bookRepair, fixwise_cancel_booking: fx.cancelBooking, fixwise_rate_repair: fx.rateRepair,
  fixwise_close_issue: fx.closeIssue, fixwise_remember: fx.remember, fixwise_recall: fx.recall, fixwise_activity: fx.activity,
};

export async function callTool(env, grant, name, args, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: [-32602, `Unknown tool: ${name}`] };
  const bad = validateArgs(tool, args ?? {});
  if (bad) return { result: { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${bad}` }] } };
  if (!hasScope(grant, tool.scope)) return { error: [-32003, `Insufficient scope: ${tool.scope} is required.`] };
  if (await overLimit(env, grant.user.sub)) return { result: { isError: true, content: [{ type: 'text', text: 'Too many requests. Try again in a minute.' }] } };
  if (name === 'fixwise_disconnect') { await revokeFamily(env, grant); return { result: { content: [{ type: 'text', text: 'Fixwise is disconnected. Link it again in the Alexa app any time.' }] } }; }
  const h = await fx.loadHousehold(env, grant.user.sub);
  const merged = await fx.mergeAdvice(env, h, grant.user.sub);
  const c = { origin: ctx.origin || env.PUBLIC_ORIGIN || '', enqueue: ctx.enqueue ? (job) => ctx.enqueue({ ...job, sub: grant.user.sub }) : null };
  const result = await HANDLERS[name](env, h, args ?? {}, c);
  if (merged || !tool.annotations.readOnlyHint || name === 'fixwise_check_status') await fx.saveHousehold(env, h);
  return { result };
}

async function dispatch(msg, env, grant, ctx) {
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return bad(msg?.id, -32600, 'Invalid Request');
  const notification = !Object.hasOwn(msg, 'id');
  const params = msg.params || {};
  const m = METHODS[msg.method];
  if (!m) return notification ? null : bad(msg.id, -32601, `Method not found: ${msg.method}`);
  return m(msg.id, params, { env, grant, ctx, notification });
}
const METHODS = {
  initialize: (id, p, { ctx }) => ok(id, { protocolVersion: PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
    serverInfo: { name: 'fixwise', title: 'Fixwise', version: '1.0.0', description: 'Home and street problems, fixed: safety first, municipal case, priced quotes, confirmed booking.', websiteUrl: ctx.origin },
    instructions: 'Fixwise helps a household get things fixed. When the customer describes a problem, call fixwise_report_problem and read the safety steps first. Never book without an explicit yes: fixwise_book_repair is two-step. Use fixwise_check_status for "any news?" questions, even days later. Municipal progress is a simulated demo feed; say so if asked.' }),
  ping: (id, p, { notification }) => (notification ? null : ok(id, {})),
  'notifications/initialized': () => null,
  'tools/list': (id) => ok(id, { tools: publicTools() }),
  'resources/list': (id) => ok(id, { resources: RESOURCES.map(({ uri, name, title, description }) => ({ uri, name, title, description, mimeType: UI_MIME })) }),
  'resources/templates/list': (id) => ok(id, { resourceTemplates: [] }),
  'resources/read': (id, p) => { const r = RESOURCES.find((x) => x.uri === p.uri); return r ? ok(id, { contents: [{ uri: r.uri, mimeType: UI_MIME, text: r.html, _meta: { ui: { prefersBorder: false } } }] }) : bad(id, -32002, 'Resource not found'); },
  'tools/call': async (id, p, { env, grant, ctx }) => { const out = await callTool(env, grant, p.name, p.arguments, ctx); return out.error ? bad(id, out.error[0], out.error[1]) : ok(id, out.result); },
};

function originAllowed(env, req, o) {
  const h = req.headers.get('origin');
  if (!h) return true; // non-browser clients (Alexa+, CLI) send no Origin
  const allow = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return h === o || allow.includes(h) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
}

export async function mcp(req, env, url, ctx = {}, { alexa = false } = {}) {
  const o = origin(env, url);
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } });
  if (!originAllowed(env, req, o)) return json(bad(null, -32000, 'Origin not allowed'), 403);
  const pv = req.headers.get('mcp-protocol-version');
  if (pv && !PROTOCOL_VERSIONS.includes(pv)) return json(bad(null, -32000, `Unsupported MCP-Protocol-Version: ${pv}`), 400);
  const grant = await bearer(req, env, o);
  if (!grant) {
    const hint = alexa ? {} : { 'www-authenticate': `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource"` };
    return json(bad(null, -32001, 'Authentication required'), 401, hint);
  }
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return json(bad(null, -32700, 'Parse error'), 400);
  if (Array.isArray(body)) return json(bad(null, -32600, 'Batching is not supported in 2025-11-25'), 400);
  const reply = await dispatch(body, env, grant, { ...ctx, origin: o });
  return reply ? json(reply, 200, { 'mcp-protocol-version': pv || PROTOCOL_VERSIONS[0] }) : new Response(null, { status: 202, headers: CORS });
}
