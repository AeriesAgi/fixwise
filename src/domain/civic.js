// Municipal side of Fixwise. Classifier, priority rules and hash-chained audit are ported from
// CivicOps (vendor/civicops/DeterministicClassifier.cs, AuditLog.cs); the work-order catalogue is CivicOps' own file.
import { readFileSync } from 'node:fs';
import { sha256hex } from '../util.js';

export const CATALOG = JSON.parse(readFileSync(new URL('../../vendor/civicops/catalog/work-orders.v1.json', import.meta.url), 'utf8'));
export const UTILITIES = JSON.parse(readFileSync(new URL('../../data/municipal-utilities.json', import.meta.url), 'utf8'));
const TYPES = new Map([...CATALOG.workOrderTypes, ...UTILITIES.workOrderTypes].map((t) => [t.code, t]));
export const typeOf = (code) => TYPES.get(code);
// Electricity and water service failures. "No power" or "no water" alone is ambiguous: one house (a tripped main
// switch, a closed stopcock: a private job) or the whole area (a municipal case). We ask one question instead of guessing.
const AREA_WORDS = /\b(neighbou?rs?|whole (street|road|area|suburb|block|complex)|entire (street|area|suburb)|everyone|everybody|the area|our area|the street is off|street is dark|whole suburb|next door)\b/;
const HOUSE_WORDS = /\b(just (us|me|our (house|home|place))|only (us|me|our (house|home|place))|neighbou?rs? (have|still have|are fine|are on)|main switch (has )?tripped|db board (has )?tripped|trip switch)\b/;
const POWER_OFF = /\b(no (power|electricity|lights)|power('s| is| has)? (off|out|gone|cut|down)|electricity('s| is)? (off|out|gone|cut)|without (power|electricity)|power outage|outage|blackout|lights are out)\b/;
const WATER_OFF = /\b(no water|water('s| is| has)? (off|gone|cut)|without water|taps? (are|is) dry|dry taps?)\b/;
export function classifyUtility(t, scope) {
  if (any(t, 'raw sewage', 'sewage', 'sewer overflow', 'sewer is overflowing', 'manhole is overflowing', 'manhole overflowing')) return 'SEW.OVERFLOW';
  if (any(t, 'cable theft', 'cables stolen', 'cable stolen', 'stole the cable', 'cable was stolen', 'cables were stolen', 'cut the cable')) return 'ELEC.CABLE_THEFT';
  if (any(t, 'power line down', 'power line is down', 'line is down', 'lines are down', 'cable on the ground', 'wire on the ground', 'fallen line', 'fallen power line', 'pole is down', 'pole down')) return 'ELEC.LIVE_WIRE_DOWN';
  if (any(t, 'substation', 'mini-sub', 'mini sub', 'minisub', 'transformer blew', 'transformer exploded', 'transformer bang')) return 'ELEC.SUBSTATION_TRIP';
  if (any(t, 'meter is leaking', 'meter leaking', 'leaking meter', 'leak at the meter', 'water meter is leaking', 'water meter leak')) return 'WATER.METER_LEAK';
  if (any(t, 'low water pressure', 'low pressure', 'pressure is low', 'pressure is weak', 'water is a trickle', 'just a trickle')) return 'WATER.LOW_PRESSURE';
  const power = POWER_OFF.test(t), water = WATER_OFF.test(t);
  if (!power && !water) return null;
  const area = scope === 'area' || (scope !== 'household' && AREA_WORDS.test(t) && !HOUSE_WORDS.test(t));
  const house = scope === 'household' || HOUSE_WORDS.test(t) || /\b(tripped|tripping|keeps tripping)\b/.test(t);
  if (area) return power ? 'ELEC.AREA_OUTAGE' : 'WATER.NO_SUPPLY';
  if (house) return power ? 'HOUSE.POWER' : 'HOUSE.WATER';
  return power ? 'ASK.POWER' : 'ASK.WATER';
}
const any = (t, ...terms) => terms.some((x) => t.includes(x));

export function classifyPublic(description, scope) {
  const t = description.toLowerCase();
  const u = classifyUtility(t, scope);
  if (u && !u.startsWith('ELEC.') && !u.startsWith('WATER.') && !u.startsWith('SEW.')) return { scope: u }; // ASK.* or HOUSE.*
  const code = u || (any(t, 'live wire', 'exposed wire', 'electrocution', 'lewendige draad') ? 'ELEC.LIVE_WIRE_DOWN'
    : any(t, 'flood response', 'flooding home', 'flooding my home', 'flooding inside', 'flooding my house', 'huis oorstroom') ? 'EMERG.FLOOD_RESPONSE'
    : any(t, 'stormwater', 'storm water', 'drain') ? 'ROADS.BLOCKED_DRAIN'
    : any(t, 'burst pipe in the street', 'burst main', 'water main', 'water in the street', 'street is flooding') ? 'WATER.BURST_MAIN'
    : any(t, 'traffic light', 'traffic signal', 'robot is out', 'robots are out') ? 'ROADS.TRAFFIC_SIGNAL_FAULT'
    : any(t, 'pothole') ? 'ROADS.POTHOLE_REPAIR'
    : any(t, 'streetlight', 'street light', 'street is dark', "street's been dark", 'street has been dark', 'street lights') ? 'ELEC.STREETLIGHT_FAULT'
    : any(t, 'rubbish', 'illegal dumping', 'dumping') ? 'WASTE.ILLEGAL_DUMPING'
    : null);
  if (!code) return null;
  const type = TYPES.get(code);
  return { code, title: type.title, category: type.category || type.department, department: type.department, hazardClass: type.hazardClass, ...(type.stallsAt != null ? { utility: true } : {}),
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
  // Utility outages in the simulated feed stall at "Acknowledged" until escalated, so the SLA follow-up can be shown.
  if (c.utility && !c.escalatedMs) return { stage: STAGES[Math.min(1, Math.floor((nowMs - c.createdMs) / (minutesPerStage * 60000)))], index: Math.min(1, Math.floor((nowMs - c.createdMs) / (minutesPerStage * 60000))) };
  if (c.utility && c.escalatedMs) { const k = Math.min(STAGES.length - 1, 2 + Math.floor((nowMs - c.escalatedMs) / (minutesPerStage * 60000))); return { stage: STAGES[k], index: k }; }
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
