// Concrete visit windows (SAST), signed .ics links, and amazon.co.za parts search links.
// Nothing here sets a reminder or touches a cart: the .ics is a file the customer can add themselves.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PARTS = JSON.parse(readFileSync(new URL('../../data/parts.json', import.meta.url), 'utf8'));
const SAST = 2 * 3600e3; const H = 3600e3;
const DEV = randomBytes(32).toString('hex');
const key = (env) => env.SESSION_SECRET || (env.ENVIRONMENT === 'production' ? null : DEV);
const sig = (k, d) => createHmac('sha256', k).update(`fixwise-ics:${d}`).digest('base64url').slice(0, 32);
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Local SAST midnight of the day `add` days after nowMs, as UTC ms.
const dayStart = (nowMs, add) => { const l = new Date(nowMs + SAST); return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + add) - SAST; };
const ceilHalf = (ms) => Math.ceil(ms / (H / 2)) * (H / 2);

// Trades work 07:00-17:00 Monday to Saturday (SAST). A same-day visit is offered only when it can start before 15:00;
// otherwise the next working morning. Evening or Sunday requests move to the next working slot.
const OPEN = 7, CLOSE = 17, LAST_SAME_DAY = 15;
const dow = (ms) => new Date(ms + SAST).getUTCDay();
function nextWorkDay(nowMs, add) { let a = add; while (dow(dayStart(nowMs, a) + 12 * H) === 0) a++; return dayStart(nowMs, a); }
export function visitWindow(slot, nowMs = Date.now()) {
  const s = String(slot || '').toLowerCase();
  let start, end;
  const urgent = /within (?:about )?\d+ hours?|\b(today|asap|now|urgent)\b/.test(s);
  const sameDayStart = Math.max(ceilHalf(nowMs + H / 2), dayStart(nowMs, 0) + OPEN * H);
  if (urgent && dow(nowMs) !== 0 && sameDayStart <= dayStart(nowMs, 0) + LAST_SAME_DAY * H) {
    start = sameDayStart; end = Math.min(start + 3 * H, dayStart(nowMs, 0) + CLOSE * H);
  } else {
    let add = 1;
    if (/within two days/.test(s)) add = 2;
    const d = DAYS.findIndex((x) => s.includes(x));
    if (d >= 0) { const cur = dow(nowMs); add = ((d - cur + 7) % 7) || 7; }
    const base = nextWorkDay(nowMs, add);
    const [a, b] = /afternoon|evening|night/.test(s) ? [12, CLOSE] : [OPEN, 12];
    start = base + a * H; end = base + b * H;
  }
  const fmt = (ms, o) => new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', ...o }).format(new Date(ms));
  const label = `${fmt(start, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmt(start, { hour: '2-digit', minute: '2-digit', hour12: false })}–${fmt(end, { hour: '2-digit', minute: '2-digit', hour12: false })} SAST`;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label };
}

export function icsLink(env, origin, ev) {
  const k = key(env); if (!k) return null;
  const d = Buffer.from(JSON.stringify(ev)).toString('base64url');
  return `${origin.replace(/\/$/, '')}/ics?d=${d}&s=${sig(k, d)}`;
}

const icsText = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n').slice(0, 300);
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function buildIcs(ev) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fixwise//Alexa+ hackathon//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${icsText(ev.ref)}@fixwise`, `DTSTAMP:${icsTime(new Date().toISOString())}`, `DTSTART:${icsTime(ev.start)}`, `DTEND:${icsTime(ev.end)}`,
    `SUMMARY:${icsText(ev.title)}`, `DESCRIPTION:${icsText(ev.desc)}`, ...(ev.area ? [`LOCATION:${icsText(ev.area)}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', `DESCRIPTION:${icsText(ev.title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
  return lines.join('\r\n') + '\r\n';
}

export function serveIcs(env, url) {
  const k = key(env); const d = url.searchParams.get('d') || ''; const s = url.searchParams.get('s') || '';
  if (!k || d.length > 2000 || s.length !== 32) return null;
  const want = Buffer.from(sig(k, d)); if (!timingSafeEqual(want, Buffer.from(s.padEnd(32).slice(0, 32)))) return null;
  let ev; try { ev = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); } catch { return null; }
  if (!ev || !ev.start || !ev.end || isNaN(Date.parse(ev.start))) return null;
  const name = `fixwise-${String(ev.ref || 'visit').replace(/[^\w-]/g, '')}.ics`;
  return new Response(buildIcs(ev), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

export function partsFor(code) {
  return (PARTS.jobs[code] || []).map((p) => ({ ...p, url: `https://www.amazon.co.za/s?k=${encodeURIComponent(p.query)}` }));
}
export const PARTS_NOTE = PARTS.note;

// No load-shedding schedule feed is legally usable here (EskomSePush's free tier is personal, non-commercial use only),
// so this is a generic tip, never a claim about the area's actual stage or slot.
const NEEDS_POWER = new Set(['HOME.GEYSER', 'HOME.ELECTRICAL', 'HOME.GATE', 'HOME.APPLIANCE']);
export function loadSheddingTip(code) {
  if (!NEEDS_POWER.has(code)) return null;
  return { tip: "If load-shedding is on, check your area's schedule for the visit day. This job needs power to test, so ask them to come outside your slot.", source: 'generic tip, not live schedule data' };
}
