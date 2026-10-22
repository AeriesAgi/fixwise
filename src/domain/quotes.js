// Private-repair side. Catalogue matching and pricing:
// suspended suppliers are excluded, money is integer cents, VAT is added once on the subtotal.
import { readFileSync } from 'node:fs';
export const HOME = JSON.parse(readFileSync(new URL('../../data/home-catalogue.json', import.meta.url), 'utf8'));

const cents = (s) => { const [r, c = ''] = String(s).split('.'); return Number(r) * 100 + Number((c + '00').slice(0, 2)); };
export const rand = (c) => `R${(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0/g, ' ')}`;
export const spokenRand = (c) => `${Math.round(c / 100)} rand`; // plain digits: TTS reads 2967 as a number, not digit by digit

export function classifyHome(description) {
  // Catalogue order is priority order: the root cause (geyser) wins over the symptom (ceiling).
  const t = description.toLowerCase();
  return HOME.jobTypes.find((j) => j.keywords.some((k) => t.includes(k))) || null;
}

// Compound reports ("the fridge is buzzing and the tap drips"): classify each clause, keep distinct jobs.
// A geyser leak explains a wet ceiling, so the roof job is dropped as a symptom when the geyser is present.
export function classifyHomeAll(description) {
  const clauses = String(description).split(/\b(?:and|also|plus|but|while)\b|[,;.!?]+/i).map((c) => c.trim()).filter(Boolean);
  const seen = new Map();
  for (const c of clauses) { const j = classifyHome(c); if (j && !seen.has(j.code)) seen.set(j.code, j); }
  if (!seen.size) { const j = classifyHome(description); if (j) seen.set(j.code, j); }
  if (seen.has('HOME.GEYSER')) seen.delete('HOME.ROOF');
  if (seen.has('HOME.GEYSER') && !/\b(tap|toilet|pipe)\b/i.test(description)) seen.delete('HOME.PIPE_LEAK');
  return [...seen.values()].slice(0, 3);
}

// "never use Budget Pipes" must match "Demo Budget Pipes" (and "budget pipes co"): compare normalised names both ways.
const normName = (x) => String(x).toLowerCase().replace(/\b(demo|the|co|cc|pty|ltd)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export function isAvoided(prefs, supplierId, supplierName) {
  const n = normName(supplierName);
  return (prefs?.avoidSuppliers || []).some((a) => { const x = normName(a); return x.length >= 3 && (a.toLowerCase() === String(supplierId).toLowerCase() || n === x || n.includes(x) || x.includes(n)); });
}
export function priceQuotes(job, { prefs = {}, urgent = false } = {}) {
  const vat = Number(HOME.vatRate);
  const out = [];
  for (const s of HOME.suppliers) {
    if (s.status !== 'active' || !s.trades.includes(job.trade) || isAvoided(prefs, s.id, s.name)) continue;
    if (!job.lines.every((l) => s.prices[l.sku])) continue;
    const lines = job.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitCents: cents(s.prices[l.sku]), totalCents: cents(s.prices[l.sku]) * l.qty }));
    const subtotal = lines.reduce((a, l) => a + l.totalCents, 0);
    const vatCents = Math.round(subtotal * vat / 100);
    out.push({ supplierId: s.id, supplier: s.name, rating: s.rating, jobs: s.jobs, etaHours: s.etaHours, afterHours: s.afterHours,
      lines, subtotalCents: subtotal, vatCents, totalCents: subtotal + vatCents, currency: HOME.currency });
  }
  // Rank: urgent jobs weigh ETA, others weigh price; rating always counts. Budget cap filters, but we say so.
  const score = (q) => (urgent ? q.etaHours * 120 : 0) + q.totalCents / 100 - q.rating * 150;
  out.sort((a, b) => score(a) - score(b));
  const cap = prefs.budgetCapCents;
  return out.map((q, i) => ({ ...q, rank: i + 1, overBudget: cap ? q.totalCents > cap : false, tag: i === 0 ? 'Recommended' : q.totalCents === Math.min(...out.map((x) => x.totalCents)) ? 'Cheapest' : q.etaHours === Math.min(...out.map((x) => x.etaHours)) ? 'Fastest' : '' }));
}
