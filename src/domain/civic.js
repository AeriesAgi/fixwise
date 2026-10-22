// Municipal side of Fixwise. Classifier, priority rules and hash-chained audit are ported from
// CivicOps (vendor/civicops/DeterministicClassifier.cs, AuditLog.cs); the work-order catalogue is CivicOps' own file.
import { readFileSync } from 'node:fs';
import { sha256hex } from '../util.js';

export const CATALOG = JSON.parse(readFileSync(new URL('../../vendor/civicops/catalog/work-orders.v1.json', import.meta.url), 'utf8'));
const TYPES = new Map(CATALOG.workOrderTypes.map((t) => [t.code, t]));
const any = (t, ...terms) => terms.some((x) => t.includes(x));

export function classifyPublic(description) {
  const t = description.toLowerCase();
  const code = any(t, 'live wire', 'exposed wire', 'electrocution', 'lewendige draad') ? 'ELEC.LIVE_WIRE_DOWN'
    : any(t, 'flood response', 'flooding home', 'flooding my home', 'flooding inside', 'flooding my house', 'huis oorstroom') ? 'EMERG.FLOOD_RESPONSE'
    : any(t, 'stormwater', 'storm water', 'drain') ? 'ROADS.BLOCKED_DRAIN'
    : any(t, 'burst pipe in the street', 'burst main', 'water main', 'water in the street', 'no water', 'street is flooding') ? 'WATER.BURST_MAIN'
    : any(t, 'traffic light', 'traffic signal', 'robot is out', 'robots are out') ? 'ROADS.TRAFFIC_SIGNAL_FAULT'
    : any(t, 'pothole') ? 'ROADS.POTHOLE_REPAIR'
    : any(t, 'streetlight', 'street light', 'street is dark', "street's been dark", 'street has been dark', 'street lights') ? 'ELEC.STREETLIGHT_FAULT'
    : any(t, 'rubbish', 'illegal dumping', 'dumping') ? 'WASTE.ILLEGAL_DUMPING'
    : null;
  if (!code) return null;
  const type = TYPES.get(code);
  return { code, title: type.title, category: type.category, department: type.department, hazardClass: type.hazardClass,
    priority: type.hazardClass === 'critical' ? 'Urgent' : priority(t), slaTargetMinutes: type.slaTargetMinutes };
}

export function priority(text) {
  const t = text.toLowerCase();
  return any(t, 'urgent', 'danger', 'trapped', 'fire', 'life threatening', 'live wire', 'flooding home', 'flooding my home', 'electrocution', 'vasgekeer', 'lewendige draad', 'huis oorstroom')
    || /\bbrand\b(?!\s+new\b)/.test(t) ? 'Urgent' : any(t, 'flood', 'outage', 'blocked') ? 'High' : 'Medium';
}

// Duplicate detection (CivicOps FindDuplicate): same area + department, word overlap >= 0.55.
const STOPW = new Set(['there', 'this', 'that', 'please', 'nearby', 'same']);
const words = (s) => new Set(String(s).toLowerCase().split(/[\s,.;:!?]+/).filter((w) => w.length > 3 && !STOPW.has(w)));
export function findDuplicate(existing, cand) {
  const cw = words(cand.description); if (!cw.size) return null;
  let best = null;
  for (const c of existing) {
    if (c.area.toLowerCase() !== cand.area.toLowerCase() || c.department !== cand.department || ['Resolved', 'Closed'].includes(c.status)) continue;
    const w = words(c.description); const overlap = [...cw].filter((x) => w.has(x)).length;
    const conf = overlap / Math.max(cw.size, w.size);
    if (conf >= 0.55 && (!best || conf > best.confidence)) best = { reference: c.reference, confidence: Math.round(conf * 100) / 100 };
  }
  return best;
}

// Simulated municipal feed: stage advances on a demo clock. Labelled as simulated everywhere it is shown.
export const STAGES = ['Logged', 'Acknowledged', 'Crew assigned', 'In progress', 'Resolved'];
export function simulatedStage(c, nowMs, minutesPerStage) {
  const idx = Math.min(STAGES.length - 1, Math.floor((nowMs - c.createdMs) / (minutesPerStage * 60000)));
  return { stage: STAGES[Math.max(0, idx)], index: Math.max(0, idx) };
}

// Hash-chained audit (CivicOps AuditLog): each record hashes its fields plus the previous hash.
export const GENESIS = '0'.repeat(64);
export async function appendChain(chain, entry) {
  const prev = chain.length ? chain[chain.length - 1].hash : GENESIS;
  const rec = { seq: chain.length + 1, at: entry.at, actor: entry.actor, action: entry.action, detail: entry.detail, prev };
  rec.hash = await sha256hex(JSON.stringify(rec));
  chain.push(rec);
  return chain;
}
export async function verifyChain(chain) {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const { hash, ...rest } = chain[i];
    if (rest.seq !== i + 1 || rest.prev !== prev || hash !== await sha256hex(JSON.stringify(rest))) return { ok: false, brokenAt: i + 1 };
    prev = hash;
  }
  return { ok: true, length: chain.length, head: prev };
}
