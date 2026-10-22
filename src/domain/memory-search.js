// Household notes search ("where's our stopcock?"). Small in-memory ranking: each query word scores by how rare it is
// across the household's notes (inverse document frequency), with a light length normalisation. Notes are capped at 100.
const STOP = new Set('a an and are as at be but by for from has have i in is it its of on or our that the this to was we were where what will with you your'.split(' '));
export function tokens(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}
export function searchMemory(items, query, { limit = 10 } = {}) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !items.length) return [];
  const docs = items.map((it) => ({ it, set: new Set(tokens(it.text)), len: tokens(it.text).length || 1 }));
  const weight = new Map(q.map((t) => { const n = docs.filter((d) => d.set.has(t)).length; return [t, n ? Math.log((docs.length + 1) / n) + 1 : 0]; }));
  return docs.map(({ it, set, len }) => ({ ...it, score: +(q.reduce((s, t) => s + (set.has(t) ? weight.get(t) : 0), 0) / Math.sqrt(len)).toFixed(4) }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.created - a.created).slice(0, Math.max(1, Math.min(50, limit | 0)));
}
