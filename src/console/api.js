// Console backend: one anonymous demo household per browser session id. Same tools, same rules as Alexa+.
// Each turn: Nova Lite (Bedrock Converse, tool use) plans -> MCP client calls the live /mcp over HTTP -> speech + MCP Apps card.
// Fallbacks: regex router if Bedrock is off/slow/failing; in-process tool call if the HTTP hop to /mcp fails.
import { route, rememberArgs } from './intents.js';
import { plan, sanitize } from './planner.js';
import { McpHttpClient } from './mcp-client.js';
import { callTool } from '../mcp/server.js';
import { issueConsoleToken } from '../oauth/oauth.js';
import { RESOURCES } from '../ui/cards.js';
import { OUT_OF_SCOPE } from '../domain/fixwise.js';
import { sha256, kvGet, kvPut, json, SEC_HEADERS, origin, now } from '../util.js';
import { consolePage, consoleScript } from './page.js';
import { createHash, createHmac, randomBytes, timingSafeEqual as tse } from 'node:crypto';

// Strict CSP: no inline script anywhere. The console's script is /console/app.js; each card's single inline script is
// allowed only by its SHA-256 hash.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const cardHash = (html) => `'sha256-${createHash('sha256').update(/<script>([\s\S]*?)<\/script>/.exec(html)[1]).digest('base64')}'`;
const CARD_CSP = new Map(RESOURCES.map((r) => [r.uri, `default-src 'none'; script-src ${cardHash(r.html)}; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'`]));

// Server-issued sessions: sid = <random>.<HMAC-SHA256(random)>. The client can't mint households, so per-session
// limits can't be dodged by inventing ids. SESSION_SECRET comes from SSM in production; dev/tests get a process key.
const DEV_KEY = randomBytes(32).toString('hex');
function sessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.ENVIRONMENT === 'production') return null; // fail closed
  return DEV_KEY;
}
const mac = (key, id) => createHmac('sha256', key).update(`fixwise-console:${id}`).digest('base64url').slice(0, 32);
export function newSession(env) { const key = sessionKey(env); if (!key) return null; const id = randomBytes(18).toString('base64url'); return `${id}.${mac(key, id)}`; }
export function verifySession(env, sid) {
  const key = sessionKey(env); const m = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{32})$/.exec(String(sid || ''));
  if (!key || !m) return false;
  const want = Buffer.from(mac(key, m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && tse(want, got);
}
const LIMITS = (env) => ({ perIpMin: Number(env.CONSOLE_PER_IP_MIN || 30), perSessionMin: Number(env.CONSOLE_PER_SESSION_MIN || 20), novaPerHour: Number(env.NOVA_PER_HOUR || 600), sessionsPerIpHour: Number(env.CONSOLE_SESSIONS_PER_IP_HOUR || 30) });
const ipOf = (req) => (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
const tooMany = (msg) => json({ error: 'rate_limited', speech: msg }, 429, { 'retry-after': '60' });

const HELP = 'Tell me what\'s broken at home or on your street. For example: "the geyser is leaking", or "the street light outside has been out for two days". I give you safety steps first, log the municipal case, get quotes, and only book when you say yes.';
const YESNO = /\b(anyway|yes|yeah|yep|sure|go ahead|book it|do it|confirm|please do|no|nope|don't|do not|not now|wait|hold off)\b/i;

function llmEnabled(env) { return env.CONSOLE_LLM !== '0' && (env.BEDROCK || env.CONSOLE_LLM === '1' || env.AWS_LAMBDA_FUNCTION_NAME); }

async function mcpClient(env, o, dialog, grant) {
  if (!dialog.tok || dialog.tok.exp < now() + 60) dialog.tok = await issueConsoleToken(env, grant, o);
  const url = env.MCP_SELF_URL || `${o}/mcp`;
  const c = new McpHttpClient({ url, token: dialog.tok.token, fetchImpl: env.MCP_FETCH || globalThis.fetch, timeoutMs: Number(env.MCP_TIMEOUT_MS || 4000) });
  c.ready = dialog.mcpReady === url; // initialize once per conversation (the server is stateless), not per turn
  return c;
}
// tools/list is static per deploy: cache it per container for 5 minutes so a turn is one model call + the tool calls.
let toolCache = null;
async function listToolsCached(client, dialog) {
  if (!toolCache || toolCache.url !== client.url || Date.now() - toolCache.at > 300000) toolCache = { url: client.url, at: Date.now(), tools: await client.listTools() };
  else await client.connect();
  dialog.mcpReady = client.url;
  return toolCache.tools;
}

async function runCall(env, client, grant, c, ctx) {
  const t0 = Date.now();
  try { const result = await client.callTool(c.tool, c.args); return { ...c, result, ms: Date.now() - t0, transport: 'mcp-http' }; }
  catch (e) {
    if (e.code) return { ...c, error: e.message, ms: Date.now() - t0, transport: 'mcp-http' }; // a JSON-RPC error is a real answer, not a transport failure
    const out = await callTool(env, grant, c.tool, c.args, ctx); // HTTP hop failed: same handler, in process
    return { ...c, result: out.result, error: out.error?.[1], ms: Date.now() - t0, transport: 'in-process', transportError: String(e.message || e).slice(0, 60) };
  }
}

export async function routeConsole(req, env, url, path, ctx) {
  if (env.CONSOLE_ENABLED === '0') return null;
  if (path === '/console' && req.method === 'GET') return new Response(consolePage(), { headers: { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS, 'content-security-policy': PAGE_CSP } });
  if (path === '/console/app.js' && req.method === 'GET') return new Response(consoleScript(), { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SEC_HEADERS } });
  if (path === '/console/api/session' && req.method === 'POST') {
    const n = await env.KV.incr(`lim:sess:${await sha256(ipOf(req))}:${Math.floor(now() / 3600)}`, 3700);
    if (n > LIMITS(env).sessionsPerIpHour) return tooMany('Too many new demo households from your network. Try again in an hour.');
    const sid = newSession(env); return sid ? json({ sid }) : json({ error: 'not_configured' }, 503);
  }
  if (path === '/console/card' && req.method === 'GET') {
    const r = RESOURCES.find((x) => x.uri === url.searchParams.get('uri'));
    if (!r) return json({ error: 'not_found' }, 404);
    return new Response(r.html, { headers: { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS, 'content-security-policy': CARD_CSP.get(r.uri) } });
  }
  if (path === '/console/api/new-conversation' && req.method === 'POST') { // same household, fresh dialogue: what Alexa+ sees on a new day
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const sid = String(b.sid || ''); if (!verifySession(env, sid)) return json({ error: 'bad_session' }, 400);
    await kvPut(env, `dlg:${await sha256(sid)}`, {}, 60); return json({ ok: true });
  }
  if (path === '/console/api/say' && req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const sid = String(b.sid || ''); const text = String(b.text || '').slice(0, 1000);
    if (!verifySession(env, sid)) return json({ error: 'bad_session' }, 400);
    const t0 = Date.now(); const o = origin(env, url);
    const sh = await sha256(sid); const L = LIMITS(env); const minute = Math.floor(now() / 60);
    // Limits run BEFORE any model call: per IP and per session per minute.
    if (await env.KV.incr(`lim:con:ip:${await sha256(ipOf(req))}:${minute}`, 120) > L.perIpMin) return tooMany('Slow down a little. Try again in a minute.');
    if (await env.KV.incr(`lim:con:s:${sh}:${minute}`, 120) > L.perSessionMin) return tooMany('Slow down a little. Try again in a minute.');
    const grant = { user: { sub: `console:${sh}` }, scope: 'fixwise.read fixwise.act', client_id: 'console', family: `console-${sh}` };
    const dkey = `dlg:${sh}`; const dialog = (await kvGet(env, dkey)) || {};
    const client = await mcpClient(env, o, dialog, grant);

    // 1. Plan. A yes/no to a held booking is decided in code; everything else goes to Nova Lite first.
    let calls = null, planner = 'regex', plannerMs = 0, tokens = null, llmText = '', fallbackReason = null;
    if (dialog.pendingOverBudget && !YESNO.test(text)) delete dialog.pendingOverBudget;
    if (dialog.pendingOverBudget && YESNO.test(text)) { // "above your limit, book it anyway?" -> a yes is decided in code, like a booking confirmation
      planner = 'confirmation-guard'; const ok = /\b(yes|yeah|yep|sure|go ahead|book it|do it|confirm|please do)\b/i.test(text); const held = dialog.pendingOverBudget; delete dialog.pendingOverBudget;
      if (!ok) { dialog.hist = [...(dialog.hist || []), { u: text.slice(0, 300), a: 'Okay, not booked.' }].slice(-4); await kvPut(env, dkey, dialog, 86400); return json({ speech: "Okay, I won't book that one. Say compare quotes to see the others.", planner, calls: [], totalMs: Date.now() - t0 }); }
      calls = [{ tool: 'fixwise_book_repair', args: { ...held, over_budget_ok: true } }];
    }
    else if (dialog.pendingApproval && YESNO.test(text)) planner = 'confirmation-guard';
    else if (llmEnabled(env) && await env.KV.incr(`lim:nova:${Math.floor(now() / 3600)}`, 3700) > L.novaPerHour) fallbackReason = 'nova_hourly_ceiling'; // global cost cap
    else if (llmEnabled(env)) {
      try {
        const tools = await listToolsCached(client, dialog);
        const p = await plan(env, { text, dialog, tools });
        plannerMs = p.ms; tokens = p.usage ? { in: p.usage.inputTokens, out: p.usage.outputTokens } : null; calls = sanitize(p.calls, tools, text); llmText = p.text; planner = 'nova-lite';
        if (calls && calls.length && !calls.some((c) => c.tool === 'fixwise_remember') && /\b(remember|budget|prefer|avoid|never use)\b/i.test(text)) {
          const ra = rememberArgs(text); if (ra && !ra.note) calls.unshift({ tool: 'fixwise_remember', args: ra }); // model dropped half a compound ask
        }
        if (calls && calls.some((c) => c.tool === 'fixwise_report_problem') && !/\b(where|what do you remember|remind me|recall)\b/i.test(text)) calls = calls.filter((c) => c.tool !== 'fixwise_recall'); // no stray "nothing remembered" on a new report
        if (calls && !calls.length) { const r = route(text, dialog); if (r.tool && r.tool !== 'fixwise_report_problem' && r.tool !== 'fixwise_disconnect') { calls = [r]; llmText = ''; planner = 'nova-lite+guard'; fallbackReason = 'grounded'; } } // never answer status/memory from chat history: ask the server
        if (!calls) { planner = 'regex'; fallbackReason = 'guarded_plan'; }
        else if (!calls.length && !llmText) { calls = null; planner = 'regex'; fallbackReason = 'empty_plan'; }
      } catch (e) { fallbackReason = String(e?.name || e?.message || e).slice(0, 60); planner = 'regex'; calls = null; }
    }
    if (!calls) {
      const r = route(text, dialog);
      if (r.help) { await kvPut(env, dkey, dialog, 86400); return json({ speech: HELP, tool: null, calls: [], planner, fallbackReason, totalMs: Date.now() - t0 }); }
      if (r.outOfScope) { await kvPut(env, dkey, dialog, 86400); return json({ speech: OUT_OF_SCOPE, tool: null, calls: [], planner, fallbackReason, totalMs: Date.now() - t0 }); }
      if (r.tool === 'fixwise_disconnect') { await kvPut(env, dkey, {}, 60); return json({ speech: 'In the real Alexa app this unlinks Fixwise. In this demo, reload to start a fresh household.', tool: r.tool, calls: [] }); }
      calls = [r];
    }

    // 2. Act: each call goes to the live MCP server over HTTP.
    const done = [];
    for (const c of calls) done.push(await runCall(env, client, grant, c, ctx));
    const speech = (done.length ? done.map((d) => d.error ? 'Sorry, something went wrong there.' : d.result?.content?.[0]?.text || '').filter(Boolean).join(' ') : '') || llmText || HELP;

    // 3. Dialogue state for the next turn.
    for (const d of done) {
      const sc = d.result?.structuredContent || {};
      if (sc.approval) dialog.pendingApproval = sc.approval.id; else if (d.tool === 'fixwise_book_repair') delete dialog.pendingApproval;
      if (d.tool === 'fixwise_book_repair' && sc.overBudget) dialog.pendingOverBudget = Object.fromEntries(Object.entries(d.args || {}).filter(([k]) => ['issue', 'rank', 'pick', 'supplier', 'time_window'].includes(k)));
      if (d.tool === 'fixwise_report_problem') { if (sc.needsArea) dialog.awaitingArea = true; else delete dialog.awaitingArea; }
      if (d.tool === 'fixwise_remember' && d.args.area) delete dialog.awaitingArea;
      if (d.args?.rank) dialog.lastRank = d.args.rank;
      dialog.lastTool = d.tool;
    }
    dialog.hist = [...(dialog.hist || []), { u: text.slice(0, 300), a: speech.slice(0, 300) }].slice(-4);
    await kvPut(env, dkey, dialog, 86400);
    const withCard = [...done].reverse().find((d) => d.result?._meta?.ui?.resourceUri);
    const first = done[0] || {};
    return json({ speech, planner, plannerMs, tokens, fallbackReason, totalMs: Date.now() - t0,
      calls: done.map((d) => ({ tool: d.tool, args: d.args, ms: d.ms, transport: d.transport, isError: !!(d.error || d.result?.isError) })),
      tool: first.tool || null, args: first.args, ms: first.ms, isError: done.some((d) => d.error || d.result?.isError),
      card: withCard ? { uri: withCard.result._meta.ui.resourceUri, data: withCard.result.structuredContent || {} } : null, awaitingYes: !!dialog.pendingApproval, awaitingArea: !!dialog.awaitingArea });
  }
  return null;
}
