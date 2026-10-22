// MCP Apps UI resources (ui:// scheme, mimeType text/html;profile=mcp-app). Each card is one self-contained HTML file.
// It speaks the MCP Apps postMessage protocol (ui/initialize, then ui/notifications/tool-result) and also renders
// window.__FIXWISE__ so the same card works in the Fixwise demo console.
export const UI_MIME = 'text/html;profile=mcp-app';
const STYLE = `:root{--bg:#0d1b1e;--card:#15292d;--ink:#eef6f4;--mut:#9dbab4;--acc:#3ddc97;--warn:#ffb454;--bad:#ff7a66}
*{box-sizing:border-box}body{margin:0;font:17px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink);padding:14px}
.h{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--acc);font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.card{background:var(--card);border-radius:18px;padding:20px;margin-top:10px}.t{font-size:26px;font-weight:700;margin:2px 0 6px}.m{color:var(--mut);font-size:13px}
.safety{border-left:4px solid var(--bad);padding:10px 12px;background:#2a1a19;border-radius:10px;margin-top:10px}.safety.urgent{border-color:var(--warn);background:#2b2416}
.steps{display:flex;gap:4px;margin:12px 0 4px}.steps i{flex:1;height:6px;border-radius:3px;background:#2c4a50}.steps i.on{background:var(--acc)}
.row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.big{font-size:34px;font-weight:800}
.car{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px}.q{min-width:240px;flex:1;scroll-snap-align:start;background:var(--card);border-radius:16px;padding:14px;border:2px solid transparent}
.q.best{border-color:var(--acc)}.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:#24403f;color:var(--acc)}.over{color:var(--warn)}
.sim{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#2c3550;color:#b9c6ff;margin-left:6px}`;
const SHELL = (title, render) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head>
<body><div id="app"><div class="h">Fixwise</div><div class="card m">Loading…</div></div><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(d){document.getElementById('app').innerHTML='<div class="h">Fixwise</div>'+(${render})(d||{});}
let rid=1;const HOST=(location.ancestorOrigins&&location.ancestorOrigins[0])||'*';const post=(m)=>window.parent!==window&&window.parent.postMessage(m,HOST);
window.addEventListener('message',e=>{if(e.source!==window.parent)return;const m=e.data||{};if(m.method==='ui/notifications/tool-result'){render((m.params||{}).structuredContent)}});
post({jsonrpc:'2.0',id:rid++,method:'ui/initialize',params:{appInfo:{name:'fixwise-card',version:'1.0.0'},appCapabilities:{},protocolVersion:'2025-11-21'}});
post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
if(window.__FIXWISE__)render(window.__FIXWISE__);
</script></body></html>`;

const ISSUE = `function(d){const list=d.issues||(d.issue?[d.issue]:[]);if(!list.length)return '<div class="card m">Nothing open.</div>';
return list.map(i=>{let h='<div class="card"><div class="m">'+esc(i.id)+(i.area?' · '+esc(i.area):'')+'</div><div class="t">'+esc((i.home&&i.home.title)||(i.case&&i.case.title)||i.summary)+'</div>';
if(i.safety&&i.safety.steps&&i.safety.steps.length)h+='<div class="safety '+(i.safety.level==='urgent'?'urgent':'')+'"><b>'+(i.safety.level==='emergency'?'Emergency':'Do this first')+'</b><br>'+i.safety.steps.map(esc).join('<br>')+(i.safety.emergency?'<br><b>'+esc(i.safety.emergency)+'</b>':'')+'</div>';
if(i.case){const c=i.case;h+='<div style="margin-top:12px" class="row"><b>'+esc(c.title)+' · '+esc(c.reference)+'</b><span class="sim">simulated feed</span></div><div class="m">'+esc(c.department)+' · '+esc(c.priority)+'</div><div class="steps">'+c.stages.map((s,k)=>'<i class="'+(k<=c.stageIndex?'on':'')+'"></i>').join('')+'</div><div class="m">'+esc(c.status)+'</div>';}
if(i.booking)h+='<div style="margin-top:12px"><b>Booked</b> · '+esc(i.booking.supplier)+'<div class="m">'+esc(i.booking.slot)+' · '+esc(i.booking.total)+' · '+esc(i.booking.reference)+'</div></div>';
else if(i.home&&i.home.quotes.length){const q=i.home.quotes[0];h+='<div style="margin-top:12px" class="row"><div><b>Best quote</b><div class="m">'+esc(q.supplier)+' · ~'+esc(q.etaHours)+' h · ★'+esc(q.rating)+'</div></div><div class="big">'+esc(q.total)+'</div></div>';}
if(i.advisorNote)h+='<div class="m" style="margin-top:10px">💡 '+esc(i.advisorNote.text)+'</div>';return h+'</div>';}).join('');}`;
const QUOTES = `function(d){const q=d.quotes||[];return '<div class="m" style="margin:6px 0">Incl. 15% VAT · synthetic demo suppliers</div><div class="car">'+q.map(x=>'<div class="q '+(x.rank===1?'best':'')+'">'+(x.tag?'<span class="tag">'+esc(x.tag)+'</span>':'')+'<div class="t" style="font-size:16px">'+esc(x.supplier)+'</div><div class="big">'+esc(x.total)+'</div><div class="m">~'+x.etaHours+' h away · ★'+x.rating+'</div>'+(x.overBudget?'<div class="over m">Over your budget</div>':'')+'<div class="m" style="margin-top:6px">Say “book number '+esc(x.rank)+'”</div></div>').join('')+'</div>';}`;
const APPROVAL = `function(d){const a=d.approval||d.booking||{};if(d.booking)return '<div class="card"><div class="t">Booked ✓</div><div>'+esc(a.supplier)+'</div><div class="m">'+esc(a.slot)+' · '+esc(a.total)+' · '+esc(a.reference)+'</div></div>';
return '<div class="card"><div class="m">Waiting for your yes</div><div class="t">'+esc(a.supplier)+'</div><div class="big">'+esc(a.total)+'</div><div class="m">'+esc(a.slot)+' · pay on completion</div><div class="m" style="margin-top:10px">Say “yes, book it” or “no”. Expires '+(a.expiresAt?new Date(a.expiresAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'soon')+'.</div></div>';}`;

export const RESOURCES = [
  { uri: 'ui://fixwise/issue', name: 'fixwise-issue', title: 'Issue timeline', description: 'Safety steps, municipal progress and the best quote for one or more issues.', html: SHELL('Fixwise issue', ISSUE) },
  { uri: 'ui://fixwise/quotes', name: 'fixwise-quotes', title: 'Quote carousel', description: 'Side-by-side repair quotes.', html: SHELL('Fixwise quotes', QUOTES) },
  { uri: 'ui://fixwise/approval', name: 'fixwise-approval', title: 'Booking confirmation', description: 'The exact quote held for the customer to confirm.', html: SHELL('Fixwise confirm', APPROVAL) },
];
