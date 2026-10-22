// Console backend: one anonymous demo household per browser session id. Same tools, same rules as Alexa+.
// Each turn: Nova Lite (Bedrock Converse, tool use) plans -> MCP client calls the live /mcp over HTTP -> speech + MCP Apps card.
// Fallbacks: regex router if Bedrock is off/slow/failing; in-process tool call if the HTTP hop to /mcp fails.
import { parseRating } from '../domain/fixwise.js';
import { LANGS, translate } from './translate.js';
import { route, rememberArgs } from './intents.js';
import { plan, sanitize } from './planner.js';
import { McpHttpClient } from './mcp-client.js';
import { callTool } from '../mcp/server.js';
import { issueConsoleToken } from '../oauth/oauth.js';
import { RESOURCES } from '../ui/cards.js';
import { OUT_OF_SCOPE, loadHousehold, saveHousehold } from '../domain/fixwise.js';
import { sha256, kvGet, kvPut, json, SEC_HEADERS, origin, now } from '../util.js';
import { consolePage, consoleScript } from './page.js';
import { synthesize, cleanForSpeech } from '../voice/polly.js';
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

const HELP = "Hi! I'm listening. Tell me what's broken at home or on your street, like a leaking geyser or no power, and I'll sort it out.";
// Stray sounds and fillers the mic picks up ("so", "um", "okay"): a short, warm nudge, no model call.
const FILLER = /^\W*(so|um+|uh+|erm+|hmm+|ah+|oh|ok(ay)?|and|but|the|a|yeah|yes|no|right|well|like|alexa)\W*$/i;
const GREETING = /^\W*(hi|hello|hey|hallo|howzit|sawubona|molo|good (morning|afternoon|evening))\b[\w\s,'?!.]*$/i;
const SCOPE_AREA = /\b(yes|yeah|yep|they are|they're|everyone|everybody|whole (street|area|road|suburb)|neighbou?rs? (are|is) (also )?(off|out|without)|also off|also without|same here|no,? (nothing|it) (has|hasn't)? ?tripped|nothing tripped|not tripped|hasn't tripped)\b/i;
const SCOPE_HOUSE = /\b(just (us|me|our)|only (us|me|our)|neighbou?rs? (have|still have|are fine|are on|aren't|are not)|they have (power|water|lights)|it (has )?tripped|the main switch (has )?tripped|switch is down|it's tripped|no,? they('re| are) fine|they're fine)\b/i;
const SHOW_ME = /^\W*(ok(ay)?,?\s*)?(please\s*)?(show|let me see|can i see)( me)?( it| that| this| the thing| the card| again)?\W*(again)?\W*$/i;
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
  if (path === '/console/api/say' && req.method === 'POST' && !req.headers.get('x-fixwise-translated')) { // Afrikaans / isiZulu: translate in, run the same turn in English, translate out
    let b; try { b = await req.clone().json(); } catch { b = {}; }
    if (LANGS[b.lang]) {
      const L = LANGS[b.lang]; const sh = await sha256(String(b.sid || ''));
      if (!verifySession(env, String(b.sid || ''))) return json({ error: 'bad_session' }, 400);
      if (await env.KV.incr(`lim:tr:${sh}:${Math.floor(now() / 3600)}`, 3700) > Number(env.TRANSLATE_PER_SESSION_HOUR || 120)) return tooMany('Translation is resting for a bit. Try English.');
      let inEn; try { inEn = await translate(env, b.text, b.lang, 'en'); } catch { return json({ speech: `Sorry, ${L.name} translation is unavailable right now. Please try English.`, planner: 'translate-failed', calls: [], lang: 'en' }); }
      const inner = await routeConsole(new Request(req.url, { method: 'POST', headers: (() => { const hh = new Headers(req.headers); hh.set('content-type', 'application/json'); hh.set('x-fixwise-translated', '1'); hh.delete('content-length'); return hh; })(), body: JSON.stringify({ ...b, text: inEn.text, lang: undefined }) }), env, url, path, ctx);
      const r = await inner.json(); if (!r.speech) return json(r, inner.status);
      let out; try { out = await translate(env, r.speech, 'en', b.lang); } catch { out = { text: r.speech, ok: false }; }
      return json({ ...r, speech: out.text, speechEn: r.speech, heardEn: inEn.text, lang: out.ok ? b.lang : 'en', translateMs: (inEn.ms || 0) + (out.ms || 0), translatedBy: 'Amazon Nova Lite' }, inner.status);
    }
  }
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
  if (path === '/console/api/skip-ahead' && req.method === 'POST') { // demo clock: move this demo household's clock forward
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const sid = String(b.sid || ''); if (!verifySession(env, sid)) return json({ error: 'bad_session' }, 400);
    const hours = Math.min(96, Math.max(1, Number(b.hours) || 48)); const ms = hours * 3600000;
    const h = await loadHousehold(env, `console:${await sha256(sid)}`);
    for (const i of h.s.issues) { i.createdMs -= ms; i.demoClockHours = (i.demoClockHours || 0) + hours; if (i.booking?.visit) { i.booking.visit.start = new Date(Date.parse(i.booking.visit.start) - ms).toISOString(); i.booking.visit.end = new Date(Date.parse(i.booking.visit.end) - ms).toISOString(); } if (i.case) { i.case.createdMs -= ms; if (i.case.escalatedMs) i.case.escalatedMs -= ms; } }
    h.s.demoClockHours = (h.s.demoClockHours || 0) + hours;
    await saveHousehold(env, h);
    return json({ ok: true, hours, totalHours: h.s.demoClockHours });
  }
  if (path === '/console/api/speak' && req.method === 'POST') { // Polly neural voice for replies (AWS credits; capped and cached)
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const sid = String(b.sid || ''); if (!verifySession(env, sid)) return json({ error: 'bad_session' }, 400);
    const text = cleanForSpeech(b.text); if (!text) return json({ error: 'empty' }, 400);
    const minute = Math.floor(now() / 60);
    if (await env.KV.incr(`lim:tts:ip:${await sha256(ipOf(req))}:${minute}`, 120) > Number(env.TTS_PER_IP_MIN || 40)) return tooMany('Voice is rate limited. Captions still work.');
    if (await env.KV.incr(`lim:tts:${Math.floor(now() / 3600)}`, 3700) > Number(env.TTS_PER_HOUR || 600)) return tooMany('Voice is resting for a bit. Captions still work.');
    try {
      const r = await synthesize(env, text, b.voice === 'en-GB' ? 'en-GB' : 'en-ZA');
      return new Response(r.audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400', 'x-fixwise-voice': r.voice, 'x-fixwise-cache': r.cached ? 'hit' : 'miss', ...SEC_HEADERS } });
    } catch (e) { console.error(JSON.stringify({ level: 'warn', msg: 'tts_failed', err: String(e?.name || e).slice(0, 60) })); return json({ error: 'tts_unavailable' }, 503); }
  }
  if (path === '/console/api/photo' && req.method === 'POST') { // photo -> live MCP tools/call fixwise_diagnose_photo (Nova Lite vision)
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const sid = String(b.sid || ''); if (!verifySession(env, sid)) return json({ error: 'bad_session' }, 400);
    const t0 = Date.now(); const o = origin(env, url); const sh = await sha256(sid); const L = LIMITS(env); const minute = Math.floor(now() / 60);
    if (await env.KV.incr(`lim:con:ip:${await sha256(ipOf(req))}:${minute}`, 120) > L.perIpMin) return tooMany('Slow down a little. Try again in a minute.');
    if (await env.KV.incr(`lim:con:s:${sh}:${minute}`, 120) > L.perSessionMin) return tooMany('Slow down a little. Try again in a minute.');
    if (await env.KV.incr(`lim:nova:${Math.floor(now() / 3600)}`, 3700) > L.novaPerHour) return tooMany('Photo checks are paused for a bit. Describe the problem in words instead.');
    const grant = { user: { sub: `console:${sh}` }, scope: 'fixwise.read fixwise.act', client_id: 'console', family: `console-${sh}` };
    const dkey = `dlg:${sh}`; const dialog = (await kvGet(env, dkey)) || {};
    const client = await mcpClient(env, o, dialog, grant); client.timeoutMs = Number(env.PHOTO_TIMEOUT_MS || 9000);
    const args = { image_base64: String(b.image_base64 || ''), media_type: String(b.media_type || ''), ...(b.note ? { note: String(b.note).slice(0, 300) } : {}) };
    if (!client.ready) { try { await client.connect(); dialog.mcpReady = client.url; } catch { /* runCall falls back in-process */ } }
    const d = await runCall(env, client, grant, { tool: 'fixwise_diagnose_photo', args }, ctx);
    const speech = d.error ? 'Sorry, I could not look at that photo.' : d.result?.content?.[0]?.text || '';
    const sc = d.result?.structuredContent || {};
    if (sc.needsArea) dialog.awaitingArea = true;
    dialog.lastTool = 'fixwise_diagnose_photo';
    if (d.result?._meta?.ui?.resourceUri) dialog.lastCard = { uri: d.result._meta.ui.resourceUri, data: sc };
    dialog.hist = [...(dialog.hist || []), { u: `[photo]${args.note ? ' ' + args.note : ''}`, a: speech.slice(0, 300) }].slice(-4);
    await kvPut(env, dkey, dialog, 86400);
    const dx = sc.diagnosis;
    return json({ speech, planner: 'nova-lite-vision', plannerMs: dx?.ms || 0, tokens: dx?.tokens || null, totalMs: Date.now() - t0,
      calls: [{ tool: 'fixwise_diagnose_photo', args: { media_type: args.media_type, image_base64: `<${Math.round(args.image_base64.length * 0.75 / 1024)} KB>`, ...(args.note ? { note: args.note } : {}) }, ms: d.ms, transport: d.transport, isError: !!(d.error || d.result?.isError) }],
      tool: 'fixwise_diagnose_photo', isError: !!(d.error || d.result?.isError),
      card: d.result?._meta?.ui?.resourceUri ? { uri: d.result._meta.ui.resourceUri, data: sc } : null, awaitingYes: !!dialog.pendingApproval, awaitingArea: !!dialog.awaitingArea });
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

    if (!dialog.pendingApproval && !dialog.pendingOverBudget && (FILLER.test(text) || (GREETING.test(text) && /\bhear (me|you)\b/i.test(text)) || /^\W*(can you )?hear me\W*$/i.test(text))) {
      const speech = FILLER.test(text) ? `Sorry, I only caught "${text.replace(/[^\w' ]/g, '').trim().slice(0, 20)}". What needs fixing?` : /hear/i.test(text) ? "Yes, I can hear you! What needs fixing at home or on your street?" : HELP;
      return json({ speech, tool: null, calls: [], planner: 'greeting-guard', totalMs: Date.now() - t0 });
    }
    // 1. Plan. A yes/no to a held booking is decided in code; everything else goes to Nova Lite first.
    let calls = null, planner = 'regex', plannerMs = 0, tokens = null, llmText = '', fallbackReason = null;
    if (dialog.pendingOverBudget && !YESNO.test(text)) delete dialog.pendingOverBudget;
    if (dialog.pendingOverBudget && YESNO.test(text)) { // "above your limit, book it anyway?" -> a yes is decided in code, like a booking confirmation
      planner = 'confirmation-guard'; const ok = /\b(yes|yeah|yep|sure|go ahead|book it|do it|confirm|please do)\b/i.test(text); const held = dialog.pendingOverBudget; delete dialog.pendingOverBudget;
      if (!ok) { dialog.hist = [...(dialog.hist || []), { u: text.slice(0, 300), a: 'Okay, not booked.' }].slice(-4); await kvPut(env, dkey, dialog, 86400); return json({ speech: "Okay, I won't book that one. Say compare quotes to see the others.", planner, calls: [], totalMs: Date.now() - t0 }); }
      calls = [{ tool: 'fixwise_book_repair', args: { ...held, over_budget_ok: true } }];
    }
    else if (SHOW_ME.test(text) && dialog.quotesOffer && !/\b(again|card)\b/i.test(text) && dialog.lastTool !== 'fixwise_compare_quotes') { // the open offer was quotes: show them
      planner = 'show-guard'; calls = [{ tool: 'fixwise_compare_quotes', args: typeof dialog.quotesOffer === 'string' ? { issue: dialog.quotesOffer } : {} }];
    }
    else if (SHOW_ME.test(text) && dialog.lastCard) { // "okay show me the thing": show the latest card again, no tool guessing
      await kvPut(env, dkey, dialog, 86400);
      return json({ speech: "Here it is.", planner: 'show-guard', calls: [], tool: dialog.lastTool || null, totalMs: Date.now() - t0, card: dialog.lastCard, awaitingYes: !!dialog.pendingApproval });
    }
    else if (dialog.pendingRating && (() => { const r = parseRating(text); return r.stars || r.fixed !== null; })()) { // "did they fix it? rate them 1 to 5" is answered in code
      planner = 'rating-guard'; const r = parseRating(text); calls = [{ tool: 'fixwise_rate_repair', args: { issue: dialog.pendingRating, ...(r.stars ? { stars: r.stars } : {}), ...(r.fixed !== null ? { fixed: r.fixed } : {}) } }];
    }
    else if (/\b(rate|rating)\b.*\b(plumber|electrician|contractor|them|him|her|supplier|repair|job)\b|\b[1-5] stars?\b/i.test(text)) { planner = 'rating-guard'; const r = parseRating(text); calls = [{ tool: 'fixwise_rate_repair', args: { ...(r.stars ? { stars: r.stars } : {}), ...(r.fixed !== null ? { fixed: r.fixed } : {}) } }]; }
    else if (/\b(why|explain|break ?down|what am i paying|how (can|do) i save|cheaper option)\b/i.test(text) && /\b(price|cost|expensive|more|quote|pay|save|cheaper|charge)/i.test(text)) { planner = 'explain-guard'; calls = [{ tool: 'fixwise_compare_quotes', args: { explain: true } }]; }
    else if (/\b(landlord|letting agent|rental agent|property (manager|owner)|my agent)\b/i.test(text)) { planner = 'landlord-guard'; calls = [{ tool: 'fixwise_share_with_landlord', args: {} }]; }
    else if (dialog.pendingEscalation && YESNO.test(text)) { // "want me to escalate?" -> yes/no decided in code
      planner = 'confirmation-guard'; const id = dialog.pendingEscalation; delete dialog.pendingEscalation;
      if (!/\b(yes|yeah|yep|sure|go ahead|do it|confirm|please do)\b/i.test(text)) { await kvPut(env, dkey, dialog, 86400); return json({ speech: "Okay, I won't escalate it yet. I'll keep watching the case.", planner, calls: [], totalMs: Date.now() - t0 }); }
      calls = [{ tool: 'fixwise_escalate', args: { issue: id, confirm: true } }];
    }
    else if (/\b(escalat\w*|ward councillor|councillor)\b/i.test(text) && !/\b(no|don't|do not)\b/i.test(text)) { planner = 'escalation-guard'; calls = [{ tool: 'fixwise_escalate', args: {} }]; } // asks first; the yes is decided in code
    else if (dialog.pendingApproval && YESNO.test(text)) planner = 'confirmation-guard';
    else if (dialog.awaitingScope && SCOPE_AREA.test(text) !== SCOPE_HOUSE.test(text)) { // answer to "are your neighbours off too?" is decided in code
      planner = 'scope-guard'; calls = [{ tool: 'fixwise_report_problem', args: { description: dialog.awaitingScope.description, scope: SCOPE_HOUSE.test(text) ? 'household' : 'area', ...(dialog.awaitingScope.area ? { area: dialog.awaitingScope.area } : {}) } }];
    }
    else if (llmEnabled(env) && await env.KV.incr(`lim:nova:${Math.floor(now() / 3600)}`, 3700) > L.novaPerHour) fallbackReason = 'nova_hourly_ceiling'; // global cost cap
    else if (llmEnabled(env)) {
      try {
        const tools = await listToolsCached(client, dialog);
        const p = await plan(env, { text, dialog, tools });
        plannerMs = p.ms; tokens = p.usage ? { in: p.usage.inputTokens, out: p.usage.outputTokens } : null; calls = sanitize(p.calls, tools, text); llmText = p.text && (p.text.split(/\s+/).length > 35 || (!p.calls.length && !/\b(fix|repair|broken|leak|geyser|power|water|where|which|suburb|street)\b/i.test(p.text))) ? OUT_OF_SCOPE : p.text; planner = 'nova-lite'; // voice rule: no rambling
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
      if (sc.offerRating) dialog.pendingRating = sc.offerRating.issue; else if (d.tool !== 'fixwise_check_status' || sc.rating) delete dialog.pendingRating;
      if (sc.offerEscalation) dialog.pendingEscalation = sc.offerEscalation.issue; else delete dialog.pendingEscalation;
      if (sc.approval) dialog.pendingApproval = sc.approval.id; else if (d.tool === 'fixwise_book_repair') delete dialog.pendingApproval;
      if (d.tool === 'fixwise_book_repair' && sc.overBudget) dialog.pendingOverBudget = Object.fromEntries(Object.entries(d.args || {}).filter(([k]) => ['issue', 'rank', 'pick', 'supplier', 'time_window'].includes(k)));
      if (d.tool === 'fixwise_report_problem') { if (sc.needsArea) dialog.awaitingArea = true; else delete dialog.awaitingArea;
        if (sc.needsScope) dialog.awaitingScope = { description: String(d.args.description || '').slice(0, 600), ...(d.args.area ? { area: d.args.area } : {}) }; else delete dialog.awaitingScope; }
      if (d.tool === 'fixwise_remember' && d.args.area) delete dialog.awaitingArea;
      if (d.args?.rank) dialog.lastRank = d.args.rank;
      // Remember the open quote offer ("...best is X at R2,967. Book it?") so a vague "show me the thing" means those quotes.
      const qIssue = sc.issue?.id && (sc.quotes?.length || sc.issue?.quotes?.length || sc.bestQuote) ? sc.issue.id : null;
      if ((d.tool === 'fixwise_report_problem' || d.tool === 'fixwise_compare_quotes') && /quotes?\b/i.test(d.result?.content?.[0]?.text || '')) dialog.quotesOffer = qIssue || dialog.quotesOffer || true;
      if (d.tool === 'fixwise_book_repair' && !sc.approval && !sc.overBudget) delete dialog.quotesOffer;
      dialog.lastTool = d.tool;
    }
    dialog.hist = [...(dialog.hist || []), { u: text.slice(0, 300), a: speech.slice(0, 300) }].slice(-4);
    await kvPut(env, dkey, dialog, 86400);
    const withCard = [...done].reverse().find((d) => d.result?._meta?.ui?.resourceUri);
    if (withCard) { dialog.lastCard = { uri: withCard.result._meta.ui.resourceUri, data: withCard.result.structuredContent || {} }; if (JSON.stringify(dialog.lastCard).length > 30000) delete dialog.lastCard; await kvPut(env, dkey, dialog, 86400); }
    const first = done[0] || {};
    return json({ speech, planner, plannerMs, tokens, fallbackReason, totalMs: Date.now() - t0,
      calls: done.map((d) => ({ tool: d.tool, args: d.args, ms: d.ms, transport: d.transport, isError: !!(d.error || d.result?.isError) })),
      tool: first.tool || null, args: first.args, ms: first.ms, isError: done.some((d) => d.error || d.result?.isError),
      card: withCard ? { uri: withCard.result._meta.ui.resourceUri, data: withCard.result.structuredContent || {} } : null, awaitingYes: !!dialog.pendingApproval, awaitingArea: !!dialog.awaitingArea, awaitingRating: !!dialog.pendingRating });
  }
  return null;
}
