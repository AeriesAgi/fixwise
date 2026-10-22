// Fixwise household service: one spoken problem becomes tracked municipal and private-repair work.
import { classifyPublic, typeOf, findDuplicate, simulatedStage, appendChain, verifyChain, STAGES } from './civic.js';
import { HOME, classifyHomeAll, priceQuotes, isAvoided, rand, spokenRand } from './quotes.js';
import { triage } from './safety.js';
import { searchMemory } from './memory-search.js';
import { sha256, sha256hex } from '../util.js';
import { visitWindow, icsLink, partsFor, PARTS_NOTE } from './calendar.js';

const UTILITY_SAFETY = {
  'ELEC.AREA_OUTAGE': { steps: ['Switch off your geyser, pool pump and sensitive electronics, so the surge when power returns does not damage them.', 'Never go near a fallen or cut cable. If one is sparking, call 112.'] },
  'ELEC.SUBSTATION_TRIP': { level: 'urgent', steps: ['Keep everyone well away from the substation or mini-sub. It may still be live.', 'Switch off sensitive appliances until power is back.'] },
  'ELEC.CABLE_THEFT': { level: 'urgent', steps: ['Do not touch or move cut cables. They may still be live.', 'If you see the theft happening, call 10111. Do not confront anyone.'] },
  'SEW.OVERFLOW': { level: 'urgent', steps: ['Keep children and pets away and do not touch the sewage.', 'Wash hands well after any contact, and keep drains in the house covered if it is backing up.'] },
  'WATER.NO_SUPPLY': { steps: ['Switch the geyser element off at the board if the water is off for long, so it does not run dry.', 'Keep a few litres of drinking water aside, and boil water for the first while after supply comes back.'] },
  'WATER.METER_LEAK': { steps: ['Do not try to open the meter box seal yourself. Note the meter reading now so you are not billed for the leak.'] },
};
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
  const r = String(ref).toLowerCase(); const norm = (x) => String(x || '').toLowerCase().replace(/[\s-]+/g, '');
  return h.s.issues.find((i) => i.id.toLowerCase() === r || norm(i.case?.reference) === norm(r) || norm(i.id) === norm(r))
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

export const OUT_OF_SCOPE = "That's outside what Fixwise does. I handle repairs at home and on your street, like a leaking geyser or a power outage. What's broken?";
// "in Sandton", "on Jan Smuts Avenue", "at 12 Oak Street": capitalised place words after a preposition.
const spokenWindow = (v) => { const m = v.label.match(/^(\w+), (\d+ \w+), (\d\d:\d\d)–(\d\d:\d\d)/); const W = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }; return m ? `${W[m[1]] || m[1]} ${m[2]}, between ${m[3]} and ${m[4]}` : v.label; };
export function extractArea(text) {
  const m = /\b(?:in|on|at|near|outside)\s+((?:\d{1,4}\s+)?(?:[A-Z][\w'-]+)(?:\s+[A-Z][\w'-]+){0,3})/.exec(String(text));
  return m ? m[1].trim().slice(0, 80) : '';
}

export async function reportProblem(env, h, args, ctx) {
  const description = args.description.trim();
  const area = (args.area || extractArea(description) || h.s.prefs.area || '').trim();
  const safety = triage(description);
  let pub = classifyPublic(description, args.scope);
  // "No power" / "no water" alone: one smart question decides household fault vs area outage.
  if (pub?.scope?.startsWith('ASK.')) {
    const power = pub.scope === 'ASK.POWER';
    h.s.awaitingScope = { description: description.slice(0, 600), area, kind: power ? 'power' : 'water', at: Date.now() };
    return say(power
      ? "Let's work out if it's just you. Are your neighbours off too? And on your DB board, has the main switch or the earth-leakage switch tripped?"
      : "Let's work out if it's just you. Do your neighbours have water? And is your stopcock at the meter fully open?",
      { needsScope: true, kind: power ? 'power' : 'water', ask: 'Call fixwise_report_problem again with the same description and scope "area" if neighbours are affected, or "household" if it is only this home.' });
  }
  let houseWater = false, housePower = false;
  if (pub?.scope) { houseWater = pub.scope === 'HOUSE.WATER'; housePower = pub.scope === 'HOUSE.POWER'; pub = null; }
  if (pub && UTILITY_SAFETY[pub.code]) { // utility-specific safety replaces generic household tips
    const own = UTILITY_SAFETY[pub.code]; safety.steps = [...safety.steps.filter((x) => !/^If only your house is off/.test(x)), ...own.steps];
    if (own.level && safety.level === 'routine') safety.level = own.level;
  }
  if (pub?.hazardClass === 'high' && pub.priority === 'Medium') pub.priority = 'High';
  delete h.s.awaitingScope;
  const homes = classifyHomeAll(description);
  if (/^HOUSE\.POWER$/.test(classifyPublic(description, args.scope)?.scope || '') && !homes.some((j) => j.code === 'HOME.ELECTRICAL')) homes.unshift(HOME.jobTypes.find((j) => j.code === 'HOME.ELECTRICAL'));
  if (pub && /^ELEC\.(AREA_OUTAGE|SUBSTATION_TRIP|CABLE_THEFT|LIVE_WIRE_DOWN)$/.test(pub.code)) { const k = homes.findIndex((j) => j.code === 'HOME.ELECTRICAL'); if (k >= 0) homes.splice(k, 1); } // an area outage is not a job for your electrician
  if (houseWater && !homes.length) return say("If your neighbours have water, the problem is on your side of the meter. Check the stopcock at the meter is fully open and look for wet patches or a hissing pipe. If it's still off, tell me it's a leaking pipe and I'll get plumber quotes.", { householdWater: true });
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
  // Voice rule: one or two short sentences. Detail (all steps, all quotes) goes on the card, not in speech.
  const parts = [];
  if (safety.emergency) parts.push(safety.emergency);
  if (safety.steps.length) parts.push('First: ' + shortStep(safety.steps[0]));
  if (issue.case) parts.push(issue.case.duplicateOf
    ? `The ${issue.case.title.toLowerCase()} is already logged as ${spell(issue.case.reference)}, so I've linked you to it.`
    : `I've logged the ${issue.case.title.toLowerCase()}${issue.case.area ? ` for ${issue.case.area}` : ''}, case ${spell(issue.case.reference)}.`);
  const withHome = created.filter((x) => x.home);
  if (withHome.length > 1) parts.push(`I've split that into ${withHome.length} repairs, ${withHome.map((x) => 'the ' + (jobKeywords(x.home.code).find((k) => description.toLowerCase().includes(k)) || x.home.title.toLowerCase().replace(/ or .*$/, ''))).join(' and ')}, with quotes on screen. Which first?`);
  else if (withHome.length) {
    const q = withHome[0].home.quotes;
    parts.push(q.length ? `${q.length} ${withHome[0].home.trade} quote${q.length > 1 ? 's' : ''}: best is ${q[0].supplier.replace(/^Demo /, '')} at ${spokenRand(q[0].totalCents)}. Book it?` : `I couldn't find a supplier for the ${withHome[0].home.title.toLowerCase()} yet.`);
  }
  if (needsArea) parts.push('Which suburb or street is it in?');
  return say(parts.join(' '), { issue: publicIssue(env, issue), issues: created.map((x) => publicIssue(env, x)), needsArea }, { ui: { resourceUri: 'ui://fixwise/issue' } });
}
// Spoken versions of the longest safety steps (the card keeps the full wording).
const SHORT = [[/at the distribution board, then close the cold-water inlet valve on top of the geyser\./, 'at the board and close the inlet valve.'], [/, usually near the meter at the boundary\. Keep people away from wet electrical points\./, '. Keep people away from wet plugs.']];
export const shortStep = (x) => SHORT.reduce((a, [re, to]) => a.replace(re, to), x);
const spell = (ref) => ref.replace(/-/g, ' ');

export function publicIssue(env, i) {
  return { id: i.id, summary: i.summary, area: i.area, state: i.state, createdAt: new Date(i.createdMs).toISOString(), safety: i.safety,
    case: i.case ? caseView(env, i.case) : null,
    home: i.home ? { title: i.home.title, trade: i.home.trade, quotes: i.home.quotes.map((q) => ({ rank: q.rank, supplier: q.supplier, supplierId: q.supplierId, total: rand(q.totalCents), totalCents: q.totalCents, etaHours: q.etaHours, rating: q.rating, tag: q.tag, overBudget: q.overBudget })) } : null,
    booking: i.booking || null, advisorNote: i.advisorNote || null, updates: i.updates.slice(-10), tracker: trackerView(env, i) };
}

// A compound report keeps the municipal case and the first private repair on one issue. When the customer asks about
// one of them ("any news on the street light?") answer only about that part.
const CASE_WORDS = /\b(street ?lights?|lights?|pothole|road|robot|traffic|drain|stormwater|dumping|rubbish|power|electricity|outage|water|sewage|sewer|cable|substation|mini-?sub|meter|pressure|municipal|case|council|CO[- ]?\d+)\b/i;
export function focusOf(i, ref) {
  if (!ref || !i?.case || !i?.home) return 'both';
  const r = String(ref).toLowerCase();
  const home = i.home.title.toLowerCase().includes(r) || jobKeywords(i.home.code).some((k) => r.includes(k) || k.includes(r));
  const caseHit = i.case.title.toLowerCase().includes(r) || i.case.reference.toLowerCase() === r || (CASE_WORDS.test(r) && !home);
  return caseHit && !home ? 'case' : home && !caseHit ? 'home' : 'both';
}
export async function checkStatus(env, h, args) {
  const i = findIssue(h, args.issue); const focus = focusOf(i, args.issue);
  if (!i) {
    const open = h.s.issues.filter((x) => x.state !== 'closed');
    if (args.issue && open.length) return say(`I couldn't find anything about ${args.issue}. You have ${open.length} open: ${open.slice(-5).map((x) => x.home?.title || x.case?.title || x.summary).join('; ')}.`, { issues: open.slice(-5).map((x) => publicIssue(env, x)) });
    return say('You have no open Fixwise issues. Tell me if something needs fixing.', { issues: [] });
  }
  const bits = [];
  let offer = null;
  if (i.case && focus !== 'home') {
    const v = caseView(env, i.case); const sla = slaOf(env, i.case);
    bits.push(`Municipal case ${spell(v.reference)} is ${v.status.toLowerCase()} (simulated feed).`);
    if (i.case.escalation) bits.push(`It was escalated as ${spell(i.case.escalation.reference)}.`);
    else if (sla?.lapsed) { bits.push(`It's been ${hrs(sla.elapsedMinutes)}, past the ${hrs(sla.targetMinutes).replace(/ hours$/, '-hour').replace(/ minutes$/, '-minute')} target. Want me to escalate it to your ward councillor?`); offer = { issue: i.id }; }
  }
  if (focus !== 'case') {
    if (i.booking) bits.push(`${i.booking.supplier.replace(/^Demo /, '')} is booked, ${i.booking.slot}.`);
    else if (i.home?.quotes.length) bits.push(`The ${i.home.title.toLowerCase().replace(/ or .*$/, '')} isn't booked yet. Best quote is ${spokenRand(i.home.quotes[0].totalCents)}.`);
    if (i.advisorNote && i.home && !bits.some((b) => /past the/.test(b))) bits.push(i.advisorNote.spoken);
  }
  const pi = publicIssue(env, i); if (focus === 'case') { pi.home = null; pi.booking = null; pi.advisorNote = null; pi.tracker = trackerView(env, { ...i, home: null, booking: null }); } else if (focus === 'home') { pi.case = null; pi.tracker = trackerView(env, { ...i, case: null }); }
  return say(bits.join(' ') || 'No updates yet.', { issue: pi, focus, ...(offer ? { offerEscalation: offer } : {}) }, { ui: { resourceUri: 'ui://fixwise/tracker' } });
}

export async function compareQuotes(env, h, args) {
  let i = findIssue(h, args.issue); let note = '';
  if (i && (focusOf(i, args.issue) === 'case' || !i.home)) { // municipal work has no quotes: use the latest issue that does
    const asked = i.case ? i.case.title.toLowerCase() : 'that';
    const q = [...h.s.issues].reverse().find((x) => x.home?.quotes.length && x.state !== 'closed');
    if (!q) return say(`The ${asked} is municipal work, so there's nothing to quote.`, { issue: i.id, quotes: [] });
    note = `The ${asked} is municipal, so no quotes. For the ${q.home.title.toLowerCase().replace(/ or .*$/, '')}: `; i = q;
  }
  if (!i?.home) return err('That issue has no private repair to quote.');
  const q = i.home.quotes.filter((x) => !isAvoided(h.s.prefs, x.supplierId, x.supplier)); const cap = h.s.prefs.budgetCapCents;
  if (!q.length) return say('Every supplier on that job is one you asked me to avoid. Tell me if you want to change that.', { issue: i.id, quotes: [] });
  for (const x of q) x.overBudget = cap ? x.totalCents > cap : false; // budget may have been set after quoting
  const best = q[0]; const cheap = [...q].sort((a, b) => a.totalCents - b.totalCents)[0];
  const text = `${note}${q.length} quotes on screen. ${best.supplier.replace(/^Demo /, '')} is best value at ${spokenRand(best.totalCents)}${cheap !== best ? `, cheapest is ${cheap.supplier.replace(/^Demo /, '')} at ${spokenRand(cheap.totalCents)}${cheap.overBudget ? '' : ''}` : ''}${best.overBudget ? ', over your budget' : ''}.`;
  return say(text + ' Which one?', { issue: i.id, quotes: publicIssue(env, i).home.quotes }, { ui: { resourceUri: 'ui://fixwise/quotes' } });
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
export async function bookRepair(env, h, args, ctx) {
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
    const visit = visitWindow(slot);
    const hold = { issue: i.id, supplierId: q.supplierId, totalCents: q.totalCents, slot: visit.label, visit };
    const a = { id: rid('AP'), digest: await sha256hex(JSON.stringify(hold)), hold, supplier: q.supplier, createdMs: Date.now(), expiresMs: Date.now() + APPROVAL_TTL_MS, state: 'pending' };
    h.s.approvals.push(a); h.s.approvals = h.s.approvals.slice(-50);
    await audit(h, 'agent', 'booking.held', `${a.id} ${q.supplierId} ${q.totalCents}`);
    return say(`To confirm: ${q.supplier}, ${spokenWindow(visit)}, ${spokenRand(q.totalCents)} including VAT, paid on completion. Shall I book it?`,
      { approval: { id: a.id, supplier: q.supplier, slot: visit.label, total: rand(q.totalCents), expiresAt: new Date(a.expiresMs).toISOString(), needs: 'Call fixwise_book_repair again with approval_id and confirm=true only after the customer says yes.' } },
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
  const visit = a.hold.visit || visitWindow(a.hold.slot);
  const ev = { ref: i.booking.reference, start: visit.start, end: visit.end, area: i.area || '', title: `${a.supplier}: ${(i.home && i.home.title) || 'repair visit'}`, desc: `Fixwise booking ${i.booking.reference}. ${i.booking.total} incl. VAT, pay on completion. Demo booking with a synthetic supplier.` };
  i.booking.visit = { ...visit, ics: ctx?.origin ? icsLink(env, ctx.origin, ev) : null };
  i.booking.reminder = { suggested: true, at: new Date(Date.parse(visit.start) - 3600e3).toISOString(), text: `${a.supplier} arrives ${visit.label}`, note: 'Suggestion only. Add the calendar file to get the alert; Fixwise does not set Alexa reminders.' };
  const parts = partsFor(i.home && i.home.code);
  if (parts.length) i.booking.parts = { items: parts, note: PARTS_NOTE };
  i.updates.push({ at: new Date().toISOString(), text: `Booked ${a.supplier} for ${a.hold.slot}` });
  await audit(h, 'household', 'booking.confirmed', `${i.booking.reference} ${a.id}`);
  return say(`Booked. ${a.supplier} comes ${spokenWindow(i.booking.visit)}, reference ${spell(i.booking.reference)}. The calendar file${parts.length ? ' and a parts list are' : ' is'} on screen.`, { booking: i.booking }, { ui: { resourceUri: 'ui://fixwise/approval' } });
}
function slotFor(q, prefs, asked) {
  const req = asked && String(asked).replace(/[^\w ,:'-]/g, '').trim().slice(0, 60);
  if (req && /\b(today|tonight|tomorrow|morning|afternoon|evening|asap|now|weekend|(mon|tues|wednes|thurs|fri|satur|sun)day|\d)/i.test(req)) return req;
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
  if (!dx.isRepairProblem || dx.confidence < 0.45 || !(dx.description || dx.problem))
    return say(`I can see ${dx.problem ? dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) : 'the photo'}, but I'm not sure enough to call it a repair. What's broken, in a few words?`, { ...base, needsWords: true }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
  const desc = [dx.description || dx.problem, dx.item && !String(dx.description).toLowerCase().includes(dx.item.toLowerCase()) ? `the ${dx.item} has a problem: ${dx.problem}` : '', dx.hazards.join(', '), args.note].filter(Boolean).join('. ').slice(0, 1000); // item + hazards keep routing and safety robust to phrasing
  const rep = await reportProblem(env, h, { description: desc, ...(args.area ? { area: args.area } : {}) }, ctx);
  if (rep.structuredContent?.outOfScope)
    return say(`From the photo it looks like ${dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}. That isn't something Fixwise can quote yet. Tell me more and I'll try.`, { ...base, needsWords: true }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
  const issue = h.s.issues.find((x) => x.id === rep.structuredContent.issue.id);
  if (issue) { issue.diagnosis = { problem: dx.problem, likelyCause: dx.likelyCause, confidence: dx.confidence, source: 'nova-lite-vision', imageSha256: img.sha256.slice(0, 16) }; issue.updates.push({ at: new Date().toISOString(), text: 'Diagnosed from a photo by Nova Lite' }); }
  await audit(h, 'agent', 'photo.diagnosed', `${issue?.id || ''} conf ${dx.confidence} img ${img.sha256.slice(0, 16)}`);
  const seen = `From your photo, it looks like ${dx.problem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`; // the likely cause is on the card
  return say(`${seen} ${rep.content[0].text}`, { ...base, ...rep.structuredContent }, { ui: { resourceUri: 'ui://fixwise/diagnosis' } });
}

// Job tracker: one timeline per issue (municipal stages with the SLA clock, and/or the private repair), plus escalation.
const hrs = (m) => (m >= 120 ? `${Math.round(m / 60)} hours` : m >= 60 ? '1 hour' : `${Math.max(1, Math.round(m))} minutes`);
export function slaOf(env, c) {
  if (!c?.slaTargetMinutes) return null;
  const elapsed = (Date.now() - c.createdMs) / 60000; const st = caseView(env, c);
  const resolved = st.status === 'Resolved';
  return { targetMinutes: c.slaTargetMinutes, elapsedMinutes: Math.round(elapsed), dueAt: new Date(c.createdMs + c.slaTargetMinutes * 60000).toISOString(), lapsed: !resolved && elapsed > c.slaTargetMinutes, resolved, label: `Target ${hrs(c.slaTargetMinutes)} (Fixwise demo target)` };
}
export function trackerView(env, i) {
  const steps = [];
  steps.push({ key: 'reported', label: 'Reported', detail: i.diagnosis ? 'From a photo, checked by Nova Lite' : 'By voice', at: new Date(i.createdMs).toISOString(), state: 'done' });
  let sla = null, escalation = null;
  if (i.case) {
    const v = caseView(env, i.case); sla = slaOf(env, i.case); escalation = i.case.escalation || null;
    STAGES.forEach((label, k) => steps.push({ key: `case-${k}`, label: k === 0 ? `Logged · ${i.case.reference}` : label, detail: k === 0 ? i.case.department : '', state: k < v.stageIndex ? 'done' : k === v.stageIndex ? (k === STAGES.length - 1 ? 'done' : 'now') : 'next', municipal: true }));
    if (escalation) steps.splice(3, 0, { key: 'escalated', label: 'Escalated', detail: escalation.to, at: escalation.at, state: 'done', municipal: true });
  }
  if (i.home) {
    steps.push({ key: 'quotes', label: `${i.home.quotes.length} quotes`, detail: i.home.quotes[0] ? `Best ${rand(i.home.quotes[0].totalCents)}` : '', state: 'done' });
    steps.push({ key: 'booked', label: i.booking ? `Booked · ${i.booking.supplier}` : 'Book a repair', detail: i.booking ? i.booking.reference : 'Waiting for your yes', state: i.booking ? 'done' : 'now' });
    steps.push({ key: 'visit', label: i.booking ? `Visit ${i.booking.slot}` : 'Visit', detail: i.booking?.visit?.label || '', state: i.booking ? (i.state === 'closed' ? 'done' : 'now') : 'next' });
  }
  steps.push({ key: 'fixed', label: 'Fixed', state: i.state === 'closed' ? 'done' : 'next' });
  return { title: i.home?.title || i.case?.title || i.summary, steps, sla, escalation, simulatedFeed: !!i.case };
}

// SLA follow-up and escalation. In this demo the escalation is recorded and shown, not sent: there is no live
// municipal or councillor channel connected, and the speech and card say so.
export async function escalate(env, h, args) {
  const open = [...h.s.issues].reverse().filter((x) => x.case && x.state !== 'closed');
  const i = args.issue ? findIssue(h, args.issue) : open.find((x) => slaOf(env, x.case)?.lapsed && !x.case.escalation) || open[0];
  if (!i?.case) return err('There is no open municipal case to escalate.');
  if (i.case.escalation) return say(`That case is already escalated, reference ${spell(i.case.escalation.reference)}.`, { issue: publicIssue(env, i) }, { ui: { resourceUri: 'ui://fixwise/tracker' } });
  const sla = slaOf(env, i.case);
  if (!sla?.lapsed) return say(`Case ${spell(i.case.reference)} is still within its ${hrs(sla?.targetMinutes || 0)} target, so it's too early to escalate. I'll keep watching it.`, { issue: publicIssue(env, i) }, { ui: { resourceUri: 'ui://fixwise/tracker' } });
  if (args.confirm !== true) return say(`Case ${spell(i.case.reference)} is ${hrs(sla.elapsedMinutes)} old, past its ${hrs(sla.targetMinutes)} target. Shall I escalate it to your ward councillor?`, { offerEscalation: { issue: i.id }, issue: publicIssue(env, i) }, { ui: { resourceUri: 'ui://fixwise/tracker' } });
  i.case.escalation = { reference: rid('ESC'), to: 'Ward councillor and the municipal service desk', at: new Date().toISOString(), simulated: true, note: 'Demo: recorded and tracked, not sent. No live municipal channel is connected.' };
  i.case.escalatedMs = Date.now();
  i.updates.push({ at: i.case.escalation.at, text: `Escalated ${i.case.escalation.reference}` });
  await audit(h, 'household', 'case.escalated', `${i.case.reference} ${i.case.escalation.reference}`);
  return say(`Done. I've escalated case ${spell(i.case.reference)} to your ward councillor and the municipal service desk, reference ${spell(i.case.escalation.reference)}. In this demo the escalation is recorded, not actually sent. I'll tell you when the crew is assigned.`, { escalated: i.case.escalation, issue: publicIssue(env, i) }, { ui: { resourceUri: 'ui://fixwise/tracker' } });
}
