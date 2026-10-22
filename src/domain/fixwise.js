// Fixwise household service: one spoken problem becomes tracked municipal and private-repair work.
import { classifyPublic, findDuplicate, simulatedStage, appendChain, verifyChain, STAGES } from './civic.js';
import { HOME, classifyHomeAll, priceQuotes, isAvoided, rand, spokenRand } from './quotes.js';
import { triage } from './safety.js';
import { searchMemory } from './memory-search.js';
import { sha256, sha256hex } from '../util.js';

const MAX_ISSUES = 50, MAX_MEMORY = 100, APPROVAL_TTL_MS = 15 * 60000;
const rid = (p) => `${p}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;

export async function loadHousehold(env, sub) {
  const key = `hh:${await sha256(sub)}`;
  const v = await env.KV.get(key);
  return { key, s: v ? JSON.parse(v) : { issues: [], approvals: [], bookings: [], memory: [], prefs: {}, chain: [], created: Date.now() } };
}
// The advisor worker never rewrites the household record (that raced with bookings made meanwhile and lost them).
// It writes its note to its own key; the next read of the household folds it in.
export async function putAdvice(env, sub, issueId, note) { await env.KV.put(`adv:${await sha256(sub)}:${issueId}`, JSON.stringify(note), { expirationTtl: 30 * 86400 }); }
export async function mergeAdvice(env, h, sub) {
  const pending = h.s.issues.filter((i) => !i.advisorNote && i.state !== 'closed' && Date.now() - i.createdMs < 30 * 86400000).slice(-5);
  if (!pending.length) return false;
  const hs = await sha256(sub); let changed = false;
  await Promise.all(pending.map(async (i) => { const v = await env.KV.get(`adv:${hs}:${i.id}`); if (v) { await attachAdvice(env, h, i.id, JSON.parse(v)); changed = true; } }));
  return changed;
}
export async function saveHousehold(env, h) { await env.KV.put(h.key, JSON.stringify(h.s), { expirationTtl: 180 * 86400 }); }
const audit = (h, actor, action, detail) => appendChain(h.s.chain, { at: new Date().toISOString(), actor, action, detail });

function minutesPerStage(env) { return Number(env.SIM_MINUTES_PER_STAGE || 3); }
function caseView(env, c) {
  const st = simulatedStage(c, Date.now(), minutesPerStage(env));
  return { reference: c.reference, title: c.title, department: c.department, priority: c.priority, area: c.area, status: st.stage, stageIndex: st.index, stages: STAGES,
    slaTargetMinutes: c.slaTargetMinutes, simulated: true, feed: 'Simulated municipal feed (CivicOps demo tenant)' };
}
function findIssue(h, ref) {
  const open = h.s.issues.filter((i) => i.state !== 'closed');
  if (!ref) return open[open.length - 1] || h.s.issues[h.s.issues.length - 1] || null;
  const r = String(ref).toLowerCase();
  return h.s.issues.find((i) => i.id.toLowerCase() === r || i.case?.reference.toLowerCase() === r)
    || pickMatch(h.s.issues.filter((i) => i.home && (i.home.title.toLowerCase().includes(r) || jobKeywords(i.home.code).some((k) => k.includes(r) || r.includes(k)))))
    || pickMatch(h.s.issues.filter((i) => i.case?.title.toLowerCase().includes(r)))
    || pickMatch(h.s.issues.filter((i) => i.summary.toLowerCase().includes(r)));
}
const jobKeywords = (code) => HOME.jobTypes.find((j) => j.code === code)?.keywords || [];
// Several issues can match one word ("geyser" reported twice). Prefer open ones, then ones with a booking, then the newest.
function pickMatch(m) {
  const open = m.filter((i) => i.state !== 'closed'); const pool = open.length ? open : m;
  return [...pool].reverse().find((i) => i.booking) || pool[pool.length - 1] || null;
}
const say = (text, structured, meta) => ({ content: [{ type: 'text', text }], structuredContent: structured, ...(meta ? { _meta: meta } : {}) });
const err = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export const OUT_OF_SCOPE = "That's outside what Fixwise does. I handle things that are broken at home, like a geyser, pipe, power, roof, gate or appliance, and problems on your street, like a street light, pothole, water main or dumping. What needs fixing?";
// "in Sandton", "on Jan Smuts Avenue", "at 12 Oak Street": capitalised place words after a preposition.
export function extractArea(text) {
  const m = /\b(?:in|on|at|near|outside)\s+((?:\d{1,4}\s+)?(?:[A-Z][\w'-]+)(?:\s+[A-Z][\w'-]+){0,3})/.exec(String(text));
  return m ? m[1].trim().slice(0, 80) : '';
}

export async function reportProblem(env, h, args, ctx) {
  const description = args.description.trim();
  const area = (args.area || extractArea(description) || h.s.prefs.area || '').trim();
  const safety = triage(description);
  const pub = classifyPublic(description);
  const homes = classifyHomeAll(description);
  if (!pub && !homes.length && safety.level === 'routine') return say(OUT_OF_SCOPE, { understood: false, outOfScope: true });
  const mk = () => ({ id: rid('FX'), summary: description.slice(0, 280), area, createdMs: Date.now(), state: 'open', safety, updates: [] });
  const issue = mk();
  if (pub) {
    const existing = h.s.issues.filter((i) => i.case).map((i) => ({ ...i.case, status: caseView(env, i.case).status }));
    const dup = area ? findDuplicate(existing, { description, area, department: pub.department }) : null;
    if (dup) issue.case = { ...h.s.issues.find((i) => i.case?.reference === dup.reference).case, duplicateOf: dup.reference };
    else issue.case = { reference: `CO-${Math.floor(10000 + Math.random() * 90000)}`, ...pub, description, area, createdMs: Date.now() };
  }
  const urgent = safety.level !== 'routine';
  const quoted = (job) => ({ code: job.code, title: job.title, trade: job.trade, quotes: priceQuotes(job, { prefs: h.s.prefs, urgent }), quotedAt: Date.now() });
  const created = [issue];
  if (homes.length) issue.home = quoted(homes[0]);
  for (const job of homes.slice(1)) { const x = mk(); x.home = quoted(job); x.summary = `${job.title} (from: ${description.slice(0, 200)})`; created.push(x); }
  h.s.issues.push(...created); h.s.issues = h.s.issues.slice(-MAX_ISSUES);
  for (const x of created) {
    await audit(h, 'household', 'issue.reported', `${x.id}${x.case ? ' case ' + x.case.reference : ''}${x.home ? ' home ' + x.home.code : ''}`);
    if (ctx?.enqueue) await ctx.enqueue({ kind: 'advise', issueId: x.id });
  }
  const needsArea = !!(issue.case && !issue.case.area && !issue.case.duplicateOf);
  if (needsArea) h.s.awaitingArea = issue.id; else delete h.s.awaitingArea;
  const parts = [];
  if (safety.emergency) parts.push(safety.emergency);
  if (safety.steps.length) parts.push('First: ' + safety.steps.join(' '));
  if (issue.case) parts.push(issue.case.duplicateOf
    ? `The ${issue.case.title.toLowerCase()} is already logged with the municipality as ${spell(issue.case.reference)}. I've linked it so you get the same updates.`
    : `I've logged the ${issue.case.title.toLowerCase()} with ${issue.case.department}${issue.case.area ? ` for ${issue.case.area}` : ''}. Your reference is ${spell(issue.case.reference)}, priority ${issue.case.priority.toLowerCase()}.`);
  const withHome = created.filter((x) => x.home);
  if (withHome.length > 1) parts.push(`I've split that into ${withHome.length} repairs.`);
  for (const x of withHome) {
    const q = x.home.quotes;
    if (q.length) parts.push(`For the ${x.home.title.toLowerCase()}, I have ${q.length} quote${q.length > 1 ? 's' : ''}. Best value is ${q[0].supplier}, ${spokenRand(q[0].totalCents)} including VAT, about ${q[0].etaHours} hours away.`);
    else parts.push(`I couldn't find an active supplier for the ${x.home.title.toLowerCase()} yet.`);
  }
  if (withHome.some((x) => x.home.quotes.length)) parts.push(withHome.length > 1 ? 'Which one should I book first, or shall I compare them?' : 'Want me to book it, or compare them?');
  if (needsArea) parts.push('Which suburb or street is the municipal problem in? The crew needs that to find it.');
  return say(parts.join(' '), { issue: publicIssue(env, issue), issues: created.map((x) => publicIssue(env, x)), needsArea }, { ui: { resourceUri: 'ui://fixwise/issue' } });
}
const spell = (ref) => ref.replace(/-/g, ' ');

export function publicIssue(env, i) {
  return { id: i.id, summary: i.summary, area: i.area, state: i.state, createdAt: new Date(i.createdMs).toISOString(), safety: i.safety,
    case: i.case ? caseView(env, i.case) : null,
    home: i.home ? { title: i.home.title, trade: i.home.trade, quotes: i.home.quotes.map((q) => ({ rank: q.rank, supplier: q.supplier, supplierId: q.supplierId, total: rand(q.totalCents), totalCents: q.totalCents, etaHours: q.etaHours, rating: q.rating, tag: q.tag, overBudget: q.overBudget })) } : null,
    booking: i.booking || null, advisorNote: i.advisorNote || null, updates: i.updates.slice(-10) };
}

export async function checkStatus(env, h, args) {
  const i = findIssue(h, args.issue);
  if (!i) {
    const open = h.s.issues.filter((x) => x.state !== 'closed');
    if (args.issue && open.length) return say(`I couldn't find anything about ${args.issue}. You have ${open.length} open: ${open.slice(-5).map((x) => x.home?.title || x.case?.title || x.summary).join('; ')}.`, { issues: open.slice(-5).map((x) => publicIssue(env, x)) });
    return say('You have no open Fixwise issues. Tell me if something needs fixing.', { issues: [] });
  }
  const bits = [];
  if (i.case) { const v = caseView(env, i.case); bits.push(`Municipal case ${spell(v.reference)} is ${v.status.toLowerCase()} (simulated feed).`); }
  if (i.booking) bits.push(`${i.booking.supplier} is booked, ${i.booking.slot}, booking ${spell(i.booking.reference)}.`);
  else if (i.home?.quotes.length) bits.push(`The ${i.home.title.toLowerCase()} isn't booked yet. Best quote is ${spokenRand(i.home.quotes[0].totalCents)} from ${i.home.quotes[0].supplier}.`);
  if (i.advisorNote) bits.push(i.advisorNote.spoken);
  return say(bits.join(' ') || 'No updates yet.', { issue: publicIssue(env, i) }, { ui: { resourceUri: 'ui://fixwise/issue' } });
}

export async function compareQuotes(env, h, args) {
  const i = findIssue(h, args.issue);
  if (!i?.home) return err('That issue has no private repair to quote.');
  const q = i.home.quotes.filter((x) => !isAvoided(h.s.prefs, x.supplierId, x.supplier)); const cap = h.s.prefs.budgetCapCents;
  if (!q.length) return say('Every supplier on that job is one you asked me to avoid. Tell me if you want to change that.', { issue: i.id, quotes: [] });
  for (const x of q) x.overBudget = cap ? x.totalCents > cap : false; // budget may have been set after quoting
  const text = q.slice(0, 3).map((x, n) => `${ordinal(n + 1)}: ${x.supplier}, ${spokenRand(x.totalCents)}, about ${x.etaHours} hours, rated ${x.rating}${x.overBudget ? ', over your budget' : ''}.`).join(' ');
  return say(text + ' Say "book the first one" or name the supplier.', { issue: i.id, quotes: publicIssue(env, i).home.quotes }, { ui: { resourceUri: 'ui://fixwise/quotes' } });
}
const ordinal = (n) => ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth'][n] || `Number ${n}`;

function pickQuote(i, args, prefs = {}) {
  const all = i.home.quotes; const q = all.filter((x) => !isAvoided(prefs, x.supplierId, x.supplier));
  if (args.supplier) { const s = args.supplier.toLowerCase(); const named = all.find((x) => x.supplier.toLowerCase().includes(s) || x.supplierId === s); if (named) return named; } // naming one overrides "avoid"
  if (args.pick === 'cheapest') return [...q].sort((a, b) => a.totalCents - b.totalCents)[0];
  if (args.pick === 'fastest') return [...q].sort((a, b) => a.etaHours - b.etaHours)[0];
  if (args.supplier) { const s = args.supplier.toLowerCase(); return q.find((x) => x.supplier.toLowerCase().includes(s) || x.supplierId === s); }
  return q[(args.rank || 1) - 1];
}

// Two-step purchase: step 1 holds the exact quote and returns a confirmation; step 2 books only with that approval.
// The hold is bound to a digest of the exact quote, works once and expires after 15 minutes.
export async function bookRepair(env, h, args) {
  const held = args.approval_id && !args.issue ? h.s.approvals.find((x) => x.id === args.approval_id) : null;
  const i = held ? h.s.issues.find((x) => x.id === held.hold.issue) : findIssue(h, args.issue);
  if (!i?.home) return err('That issue has no private repair to book.');
  if (i.booking) return say(`That's already booked with ${i.booking.supplier}, ${i.booking.slot}.`, { booking: i.booking });
  if (!args.approval_id) {
    const q = pickQuote(i, args, h.s.prefs);
    if (!q) return err('I could not find that quote. Ask me to compare quotes first.');
    if (h.s.prefs.budgetCapCents && q.totalCents > h.s.prefs.budgetCapCents && !args.over_budget_ok)
      return say(`That quote is ${spokenRand(q.totalCents)}, above your ${spokenRand(h.s.prefs.budgetCapCents)} limit. Shall I book it anyway?`, { overBudget: true });
    const slot = slotFor(q, h.s.prefs, args.time_window);
    const hold = { issue: i.id, supplierId: q.supplierId, totalCents: q.totalCents, slot };
    const a = { id: rid('AP'), digest: await sha256hex(JSON.stringify(hold)), hold, supplier: q.supplier, createdMs: Date.now(), expiresMs: Date.now() + APPROVAL_TTL_MS, state: 'pending' };
    h.s.approvals.push(a); h.s.approvals = h.s.approvals.slice(-50);
    await audit(h, 'agent', 'booking.held', `${a.id} ${q.supplierId} ${q.totalCents}`);
    return say(`To confirm: ${q.supplier}, ${slot}, ${spokenRand(q.totalCents)} including VAT, paid on completion. Shall I book it?`,
      { approval: { id: a.id, supplier: q.supplier, slot, total: rand(q.totalCents), expiresAt: new Date(a.expiresMs).toISOString(), needs: 'Call fixwise_book_repair again with approval_id and confirm=true only after the customer says yes.' } },
      { ui: { resourceUri: 'ui://fixwise/approval' } });
  }
  const a = h.s.approvals.find((x) => x.id === args.approval_id && x.hold.issue === i.id);
  if (!a || a.state !== 'pending') return err('That confirmation is no longer valid. Ask me to book it again.');
  if (Date.now() > a.expiresMs) { a.state = 'expired'; return err('That confirmation expired. Ask me to book it again.'); }
  if (await sha256hex(JSON.stringify(a.hold)) !== a.digest) return err('That confirmation does not match the held quote.');
  if (args.confirm !== true) { a.state = 'declined'; await audit(h, 'household', 'booking.declined', a.id); return say('Okay, I have not booked anything.', { declined: true }); }
  a.state = 'redeemed';
  i.booking = { reference: rid('BK'), supplier: a.supplier, supplierId: a.hold.supplierId, slot: a.hold.slot, total: rand(a.hold.totalCents), totalCents: a.hold.totalCents,
    payment: 'Pay on completion. Fixwise does not take card details.', simulated: true, note: 'Synthetic supplier; booking is simulated for the demo.' };
  i.updates.push({ at: new Date().toISOString(), text: `Booked ${a.supplier} for ${a.hold.slot}` });
  await audit(h, 'household', 'booking.confirmed', `${i.booking.reference} ${a.id}`);
  return say(`Booked. ${a.supplier} is coming ${a.hold.slot}. Your booking reference is ${spell(i.booking.reference)}. I'll keep an eye on the municipal side too.`, { booking: i.booking }, { ui: { resourceUri: 'ui://fixwise/approval' } });
}
function slotFor(q, prefs, asked) {
  const req = asked && String(asked).replace(/[^\w ,:'-]/g, '').trim().slice(0, 60);
  if (req) return req;
  const when = prefs.timeWindow || (q.etaHours <= 6 ? 'today' : q.etaHours <= 24 ? 'tomorrow morning' : 'within two days');
  return q.etaHours <= 6 && !prefs.timeWindow ? `today, within about ${q.etaHours} hours` : `${when}`;
}

export async function cancelBooking(env, h, args) {
  const i = findIssue(h, args.issue);
  if (!i?.booking) return err('There is no booking on that issue.');
  const b = i.booking; i.booking = null; i.updates.push({ at: new Date().toISOString(), text: `Cancelled booking ${b.reference}` });
  await audit(h, 'household', 'booking.cancelled', b.reference);
  return say(`Cancelled the booking with ${b.supplier}.`, { cancelled: b.reference });
}

export async function remember(env, h, args) {
  const p = h.s.prefs; const changed = [];
  if (args.budget_cap_rand != null) { p.budgetCapCents = Math.round(Number(args.budget_cap_rand) * 100); changed.push(`a budget limit of ${args.budget_cap_rand} rand`); }
  if (args.time_window) { p.timeWindow = String(args.time_window).slice(0, 60); changed.push(`visits ${p.timeWindow}`); }
  if (args.area) {
    p.area = String(args.area).slice(0, 80); changed.push(`your area as ${p.area}`);
    const w = h.s.awaitingArea && h.s.issues.find((i) => i.id === h.s.awaitingArea);
    if (w?.case && !w.case.area) { w.case.area = p.area; if (!w.area) w.area = p.area; w.updates.push({ at: new Date().toISOString(), text: `Location added: ${p.area}` }); changed.push(`and added it to municipal case ${spell(w.case.reference)}`); }
    delete h.s.awaitingArea;
  }
  if (args.avoid_supplier) { p.avoidSuppliers = [...new Set([...(p.avoidSuppliers || []), String(args.avoid_supplier).slice(0, 80)])]; changed.push(`never to use ${args.avoid_supplier}`); }
  if (args.note) { h.s.memory.push({ id: rid('M'), text: String(args.note).slice(0, 500), created: Date.now(), source: 'household' }); h.s.memory = h.s.memory.slice(-MAX_MEMORY); changed.push('that note'); }
  if (!changed.length) return err('Tell me what to remember: a budget limit, preferred visit times, your area, a supplier to avoid, or a note.');
  await audit(h, 'household', 'prefs.updated', changed.join('; '));
  const list = changed.length > 1 ? `${changed.slice(0, -1).join(', ')} and ${changed[changed.length - 1]}` : changed[0];
  return say(`Got it. I'll remember ${list}.`, { prefs: p });
}

export async function recall(env, h, args) {
  const hits = args.query ? searchMemory(h.s.memory, args.query, { limit: 5 }) : h.s.memory.slice(-5).reverse();
  const p = h.s.prefs || {}; const pb = [];
  if (p.budgetCapCents) pb.push(`your budget limit is ${spokenRand(p.budgetCapCents)}`);
  if (p.timeWindow) pb.push(`you prefer visits ${p.timeWindow}`);
  if (p.area) pb.push(`you're in ${p.area}`);
  if (p.avoidSuppliers?.length) pb.push(`you never want ${p.avoidSuppliers.join(' or ')}`);
  const prefAsk = !args.query || /\b(budget|limit|spend|time|visit|prefer|area|suburb|supplier|avoid|use|settings?|preferences?|remember)\b/i.test(args.query);
  const prefText = pb.length && (prefAsk || !hits.length) ? `${pb.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : '';
  const text = [prefText, hits.map((m) => m.text).join(' ')].filter(Boolean).join(' ') || 'I have nothing remembered about that yet.';
  return say(text, { memory: hits, prefs: h.s.prefs });
}

export async function listIssues(env, h) {
  const items = h.s.issues.filter((i) => i.state !== 'closed').slice(-10).reverse().map((i) => publicIssue(env, i));
  if (!items.length) return say('Nothing open. Everything is fixed.', { issues: [] });
  return say(`You have ${items.length} open: ` + items.map((i) => i.home?.title || i.case?.title || i.summary).join('; ') + '.', { issues: items }, { ui: { resourceUri: 'ui://fixwise/issue' } });
}

export async function closeIssue(env, h, args) {
  const i = findIssue(h, args.issue); if (!i) return err('I could not find that issue.');
  i.state = 'closed'; await audit(h, 'household', 'issue.closed', i.id);
  return say('Marked as fixed. Glad that is sorted.', { closed: i.id });
}

export async function activity(env, h) {
  const v = await verifyChain(h.s.chain);
  return say(`${h.s.chain.length} recorded actions. Audit chain ${v.ok ? 'verified' : 'BROKEN at entry ' + v.brokenAt}.`, { verify: v, recent: h.s.chain.slice(-20).reverse() });
}

// Worker-side: attach the advisor note produced asynchronously (Bedrock via AgentCore, or the local fallback).
export async function attachAdvice(env, h, issueId, note) {
  const i = h.s.issues.find((x) => x.id === issueId); if (!i) return false;
  i.advisorNote = note; i.updates.push({ at: new Date().toISOString(), text: 'Advisor note ready' });
  await audit(h, 'agent', 'advice.attached', `${issueId} ${note.source}`);
  return true;
}

// Photo diagnosis. Nova Lite looks at the photo, then the diagnosis goes through the SAME safety triage, municipal
// routing and quoting as a spoken report. Low confidence or a non-repair photo asks the customer instead of guessing.
import { decodeImage, diagnoseImage } from './vision.js';
const PHOTO_PER_HOUR = 12;
export async function diagnosePhoto(env, h, args, ctx) {
  const img = decodeImage(args.image_base64, args.media_type);
  if (img.error) return err(img.error);
  const hourKey = `lim:photo:${h.key}:${Math.floor(Date.now() / 3600000)}`;
  if (await env.KV.incr(hourKey, 3700) > PHOTO_PER_HOUR) return err('That is a lot of photos this hour. Describe the problem in words instead, or try again later.');
  let r;
  try { r = await diagnoseImage(env, img, args.note || ''); }
  catch { return err("I couldn't look at the photo just now. Tell me in a few words what's broken and I'll take it from there."); }
  const dx = r.dx;
  if (!dx) return err("I couldn't make sense of that photo. Tell me in a few words what's broken.");
  const base = { diagnosis: { ...dx, model: 'Amazon Nova Lite', ms: r.ms, tokens: r.usage, imageSha256: img.sha256.slice(0, 16), stored: false } };
  if (!dx.isRepairProblem || dx.confidence < 0.45 || !dx.description)
    return say(`I can see ${dx.problem ? dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) : 'the photo'}, but I'm not sure enough to call it a repair. What's broken, in a few words?`, { ...base, needsWords: true }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
  const desc = [dx.description, dx.hazards.join(', '), args.note].filter(Boolean).join('. ').slice(0, 1000);
  const rep = await reportProblem(env, h, { description: desc, ...(args.area ? { area: args.area } : {}) }, ctx);
  if (rep.structuredContent?.outOfScope)
    return say(`From the photo it looks like ${dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}. That isn't something Fixwise can quote yet. Tell me more and I'll try.`, { ...base, needsWords: true }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
  const issue = h.s.issues.find((x) => x.id === rep.structuredContent.issue.id);
  if (issue) { issue.diagnosis = { problem: dx.problem, likelyCause: dx.likelyCause, confidence: dx.confidence, source: 'nova-lite-vision', imageSha256: img.sha256.slice(0, 16) }; issue.updates.push({ at: new Date().toISOString(), text: 'Diagnosed from a photo by Nova Lite' }); }
  await audit(h, 'agent', 'photo.diagnosed', `${issue?.id || ''} conf ${dx.confidence} img ${img.sha256.slice(0, 16)}`);
  const seen = `From your photo, it looks like ${dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}. ${dx.likelyCause ? 'Likely cause: ' + dx.likelyCause.replace(/^./, (c) => c.toLowerCase()).replace(/\.?$/, '.') : ''}`.trim();
  return say(`${seen} ${rep.content[0].text}`, { ...base, ...rep.structuredContent }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
}
