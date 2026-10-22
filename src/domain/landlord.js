// Landlord view: a signed, read-only, expiring page a tenant can share with their landlord or letting agent.
// Fixwise never sends it: the tenant copies or shares the link themselves. Live data from the household record.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { esc } from '../util.js';

const DEV = randomBytes(32).toString('hex');
const key = (env) => env.SESSION_SECRET || (env.ENVIRONMENT === 'production' ? null : DEV);
const sig = (k, d) => createHmac('sha256', k).update(`fixwise-landlord:${d}`).digest('base64url').slice(0, 32);
const TTL = 7 * 86400e3;

export function landlordLink(env, origin, hkey, nowMs = Date.now()) {
  const k = key(env); if (!k) return null;
  const exp = nowMs + TTL; const d = Buffer.from(JSON.stringify({ k: hkey, exp })).toString('base64url');
  return { url: `${origin.replace(/\/$/, '')}/landlord?d=${d}&s=${sig(k, d)}`, expires: new Date(exp).toISOString() };
}
export function verifyLandlord(env, url) {
  const k = key(env); const d = url.searchParams.get('d') || ''; const s = url.searchParams.get('s') || '';
  if (!k || d.length > 400 || s.length !== 32 || !timingSafeEqual(Buffer.from(sig(k, d)), Buffer.from(s))) return null;
  try { const v = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); return v.exp > Date.now() && /^hh:/.test(v.k) ? v : null; } catch { return null; }
}

const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1418;color:#e8f4f8}
main{max-width:860px;margin:0 auto;padding:20px 16px 40px}h1{font-size:24px;margin:0 0 4px}.m{color:#9fb3bd;font-size:14px}.card{background:#12222a;border:1px solid #1f3540;border-radius:16px;padding:16px;margin-top:14px}
.t{font-size:19px;font-weight:700;margin:2px 0 6px}.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:#24324a;color:#b8c7ff;margin-left:6px}
.sum{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}.sum div{background:#12222a;border:1px solid #1f3540;border-radius:14px;padding:12px}.sum b{display:block;font-size:22px}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px}.ok{color:#3ddc97}.warn{color:#ffb86b}.safety{margin-top:8px;padding:10px 12px;border-radius:12px;background:#2a2410;color:#f3d98a;font-size:14px}
@media(max-width:560px){.sum{grid-template-columns:1fr 1fr}.sum div:last-child{grid-column:span 2}h1{font-size:21px}}`;

export function renderLandlord(h) {
  const issues = [...h.s.issues].reverse().slice(0, 20);
  const open = issues.filter((i) => i.state !== 'closed');
  const committed = issues.reduce((a, i) => a + (i.booking?.totalCents || 0), 0);
  const fmt = (c) => 'R' + Math.round(c / 100).toLocaleString('en-US');
  const when = (ms) => new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const card = (i) => {
    let x = `<section class="card"><div class="m">${esc(i.id)}${i.area ? ' · ' + esc(i.area) : ''} · reported ${esc(when(i.createdMs))} SAST${i.state === 'closed' ? ' · <span class="ok">fixed</span>' : ''}</div><div class="t">${esc(i.home?.title || i.case?.title || i.summary)}</div>`;
    if (i.safety?.steps?.length && i.state !== 'closed') x += `<div class="safety"><b>Safety step given to the tenant:</b> ${esc(i.safety.steps[0])}</div>`;
    if (i.case) x += `<div class="row"><span>Municipal case <b>${esc(i.case.reference)}</b><span class="pill">simulated feed</span></span><span class="m">${esc(i.case.department || '')}${i.case.escalation ? ' · escalated ' + esc(i.case.escalation.reference) : ''}</span></div>`;
    if (i.booking) x += `<div class="row"><span>Booked <b>${esc(i.booking.supplier)}</b> · ${esc(i.booking.visit?.label || i.booking.slot)}</span><b>${esc(i.booking.total)}</b></div>${i.booking.rating ? `<div class="m">Tenant rated ${i.booking.rating.stars}/5${i.booking.rating.fixed ? ', fixed' : ', not fixed'}</div>` : ''}`;
    else if (i.home?.quotes?.length) x += `<div class="row"><span>Best quote <b>${esc(i.home.quotes[0].supplier)}</b> · ~${esc(i.home.quotes[0].etaHours)} h</span><b>${fmt(i.home.quotes[0].totalCents)}</b></div><div class="m">${i.home.quotes.length} quotes incl. 15% VAT · not booked yet</div>`;
    for (const b of (i.pastBookings || []).filter((b) => b.rating && !b.rating.fixed)) x += `<div class="m">Earlier visit: ${esc(b.supplier)} · ${esc(b.visit?.label || b.slot || '')} · not fixed, tenant rated ${b.rating.stars}/5</div>`;
    return x + '</section>';
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Fixwise · landlord view</title><style>${CSS}</style></head><body><main>
<div class="m">FIXWISE · LANDLORD VIEW · read-only</div><h1>Repairs at your rental</h1><div class="m">Shared by your tenant from Fixwise for Alexa+. Live, read-only, link expires in 7 days. Demo data: synthetic suppliers and a simulated municipal feed.</div>
<div class="sum"><div><span class="m">Open</span><b>${open.length}</b></div><div><span class="m">Booked</span><b>${issues.filter((i) => i.booking).length}</b></div><div><span class="m">Committed (incl. VAT)</span><b>${fmt(committed)}</b></div></div>
${issues.length ? issues.map(card).join('') : '<section class="card m">No repairs reported.</section>'}
</main></body></html>`;
}

export async function serveLandlord(env, url) {
  const v = verifyLandlord(env, url); if (!v) return null;
  const raw = await env.KV.get(v.k); const h = { key: v.k, s: raw ? JSON.parse(raw) : { issues: [] } };
  return new Response(renderLandlord(h), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
}
