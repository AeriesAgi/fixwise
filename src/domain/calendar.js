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
const part = (s) => /morning/.test(s) ? [8, 12] : /afternoon/.test(s) ? [12, 17] : /evening/.test(s) ? [17, 20] : [8, 17];
const ceilHalf = (ms) => Math.ceil(ms / (H / 2)) * (H / 2);

export function visitWindow(slot, nowMs = Date.now()) {
  const s = String(slot || '').toLowerCase();
  let start, end;
  const within = s.match(/within (?:about )?(\d+) hours?/);
  if (within) { start = ceilHalf(nowMs + H / 2); end = Math.max(ceilHalf(nowMs + Number(within[1]) * H), start + 2 * H); }
  else {
    let add = 1;
    if (/\btoday\b/.test(s)) add = 0; else if (/within two days/.test(s)) add = 2;
    const d = DAYS.findIndex((x) => s.includes(x));
    if (d >= 0) { const cur = new Date(nowMs + SAST).getUTCDay(); add = ((d - cur + 7) % 7) || 7; }
    const [a, b] = part(s); start = dayStart(nowMs, add) + a * H; end = dayStart(nowMs, add) + b * H;
    if (end <= nowMs) { start += 86400e3; end += 86400e3; }
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
