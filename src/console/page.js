// The simulated Alexa+ console: an Echo Show-style screen with the MCP Apps card, a voice-first transcript,
// the Alexa light bar, browser speech in and out, and a live trace of the real MCP tool calls behind each turn.
export function consolePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fixwise · Simulated Alexa+ console</title>
<style>
:root{--bg:#070d12;--panel:#0f1a21;--ink:#eef6f4;--mut:#a9c2c3;--acc:#3ddc97;--alexa:#1ec8ff;--line:#1c2c35}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 20% -10%,#12303a 0,transparent 60%),var(--bg);color:var(--ink)}
header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px}
.logo{display:flex;gap:10px;align-items:center;font-weight:800;font-size:18px;letter-spacing:.01em}.logo i{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--acc),#13a8a0);display:inline-block}
.badge{font-size:12px;color:#b9c6ff;background:#1d2546;border:1px solid #2e3a6b;padding:5px 10px;border-radius:99px}
main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(340px,1fr);gap:24px;padding:0 28px 28px;max-width:1400px;margin:0 auto}
@media(max-width:900px){main{grid-template-columns:1fr}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.skip{position:absolute;left:-999px;top:8px;background:var(--acc);color:#05261b;padding:8px 12px;border-radius:8px;z-index:9}.skip:focus{left:8px}
:focus-visible{outline:3px solid var(--alexa);outline-offset:2px}.trace .fb{color:#ffb454}.trace .pl{color:#b9c6ff}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.device{background:#05080b;border-radius:30px;padding:18px;box-shadow:0 30px 80px #000a,inset 0 0 0 2px #1a2228}
.screen{position:relative;background:#0d1b1e;border-radius:18px;aspect-ratio:16/10;overflow:hidden}
.screen iframe{position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;transition:opacity .35s}.screen iframe.on{opacity:1}
.idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:24px}
.idle .clock{font-size:64px;font-weight:200;letter-spacing:-.02em}.idle .hint{color:var(--mut)}
.bar{height:6px;margin:14px auto 2px;width:62%;border-radius:6px;background:#101820;overflow:hidden;position:relative}
.bar::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--alexa),#5ce1ff,var(--alexa),transparent);transform:translateX(-100%);opacity:0}
.bar.listen::after{opacity:1;animation:none;transform:none;background:var(--alexa)}
.bar.think::after{opacity:1;animation:sweep 1.1s linear infinite}.bar.speak::after{opacity:1;animation:pulse 1s ease-in-out infinite;transform:none}
@keyframes sweep{to{transform:translateX(100%)}}@keyframes pulse{50%{opacity:.35}}
.side{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:22px;min-height:560px;max-height:calc(100vh - 110px)}
.log{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.msg{max-width:88%;padding:11px 14px;border-radius:16px;white-space:pre-wrap;animation:in .25s ease}.me{align-self:flex-end;background:#1f3a44;border-bottom-right-radius:4px}
.ax{align-self:flex-start;background:#13262d;border:1px solid #1d3a43;border-bottom-left-radius:4px}.ax b{color:var(--alexa);font-size:12px;display:block;margin-bottom:2px;letter-spacing:.06em}
.trace{align-self:flex-start;font:12px ui-monospace,Menlo,monospace;color:#7fa3a0;background:#0b1418;border:1px dashed #20343b;padding:6px 10px;border-radius:10px;display:none}.show-trace .trace{display:block}
@keyframes in{from{transform:translateY(6px);opacity:0}}
.chips{display:flex;gap:8px;flex-wrap:wrap;padding:0 18px 12px}.chip{font:inherit;font-size:13px;color:var(--ink);background:#132329;border:1px solid #234049;border-radius:99px;padding:7px 12px;cursor:pointer}.chip:hover{border-color:var(--acc)}
form{display:flex;gap:8px;padding:14px;border-top:1px solid var(--line)}
input{flex:1;min-width:0;font:inherit;color:var(--ink);background:#0a1419;border:1px solid #4a7380;border-radius:14px;padding:12px 14px}input:focus{border-color:var(--alexa)}
button{font:inherit;border:0;border-radius:14px;padding:0 16px;cursor:pointer;font-weight:700}.mic{width:48px;background:#13323d;color:var(--alexa);font-size:20px}.mic.on{background:var(--alexa);color:#03202b}
.send{background:var(--acc);color:#05261b}
.foot{display:flex;justify-content:space-between;align-items:center;padding:0 18px 14px;color:var(--mut);font-size:12px}.foot label{cursor:pointer}
.hdr-r{display:flex;gap:10px;align-items:center}.live{font-size:12px;color:#bff5dc;background:#0f2a20;border:1px solid #1f5a43;padding:5px 10px;border-radius:99px;display:flex;gap:6px;align-items:center}.live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 0 #3ddc9799;animation:ping 1.8s infinite}@keyframes ping{70%{box-shadow:0 0 0 8px #3ddc9700}}
.reset{font-size:12px;font-weight:600;color:var(--mut);background:transparent;border:1px solid var(--line);padding:5px 10px;border-radius:99px}.reset:hover{color:var(--ink);border-color:var(--mut)}
.cap{position:absolute;left:8%;right:8%;bottom:4%;z-index:3;text-align:center;font-size:clamp(13px,1.15vw,17px);font-weight:500;line-height:1.35;color:#fff;background:#000c;backdrop-filter:blur(6px);padding:8px 14px;border-radius:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;opacity:0;transform:translateY(8px);transition:.3s;pointer-events:none}.cap.on{opacity:1;transform:none}.no-cap .cap{display:none}
.dots{align-self:flex-start;display:flex;gap:5px;padding:12px 14px;background:#13262d;border:1px solid #1d3a43;border-radius:16px;border-bottom-left-radius:4px}.dots i{width:7px;height:7px;border-radius:50%;background:var(--alexa);animation:dot 1s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}@keyframes dot{50%{opacity:.25;transform:translateY(-3px)}}
.trace b{color:var(--acc);font-weight:600}
.mic{position:relative;touch-action:none;-webkit-user-select:none;user-select:none}.mic::after{content:"";position:absolute;inset:-5px;border-radius:18px;border:3px solid var(--alexa);opacity:0;pointer-events:none}.mic.on::after{opacity:1;animation:ring 1.2s ease-out infinite}@keyframes ring{0%{transform:scale(.9);opacity:.9}100%{transform:scale(1.35);opacity:0}}
.cam{width:48px;background:#13323d;color:var(--ink);font-size:19px;display:grid;place-items:center}.cam input{display:none}
.orb{position:absolute;top:14px;right:14px;z-index:4;width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#7fe9ff,var(--alexa) 45%,#0b5c7a);box-shadow:0 0 0 0 #1ec8ff66;opacity:0;transform:scale(.6);transition:.25s;pointer-events:none}.orb.listen,.orb.think,.orb.speak{opacity:1;transform:none}.orb.listen{animation:breathe 1.1s ease-in-out infinite}.orb.think{animation:spin 1s linear infinite;background:conic-gradient(var(--alexa),#5ce1ff,#0b5c7a,var(--alexa))}.orb.speak{animation:talk .45s ease-in-out infinite alternate}
@keyframes breathe{50%{box-shadow:0 0 0 14px #1ec8ff00;transform:scale(1.08)}}@keyframes spin{to{transform:rotate(1turn)}}@keyframes talk{to{box-shadow:0 0 0 10px #1ec8ff33;transform:scale(1.12)}}
.interim{align-self:flex-end;opacity:.7;font-style:italic}.photo{max-width:220px;border-radius:12px;display:block;margin-top:6px}
.stop{display:none;font-size:12px;font-weight:700;color:#03202b;background:var(--alexa);border-radius:99px;padding:6px 12px;position:absolute;top:18px;left:18px;z-index:4}.stop.on{display:inline-block}.snd{display:none;position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:5;font-size:14px;font-weight:700;color:#03202b;background:#ffd58a;border-radius:99px;padding:10px 16px;box-shadow:0 6px 20px #0008}.snd.on{display:inline-block}.kbd{opacity:.7}
.yes{display:none;gap:8px;padding:0 18px 12px}.yes.on{display:flex}.yes button{padding:10px 18px}.y{background:var(--acc);color:#05261b}.n{background:#2a3a40;color:var(--ink)}
main>*{min-width:0}.chip{max-width:100%;text-align:left}
@media(max-width:600px){html,body{overflow-x:hidden}header{flex-direction:column;align-items:flex-start;gap:10px;padding:12px 14px}.hdr-r{flex-wrap:wrap;gap:6px}.badge{display:none}main{padding:0 10px 16px;gap:14px}.device{padding:8px;border-radius:18px}.screen{aspect-ratio:4/3}.idle .clock{font-size:40px}.side{min-height:420px;max-height:none;border-radius:16px}.msg{max-width:96%}.foot{flex-wrap:wrap;gap:8px}.kbd{display:none}form{padding:10px}button,.chip{min-height:44px}}
</style></head><body>
<a class="skip" href="#t">Skip to message box</a><header><div class="logo"><i></i>Fixwise <span style="color:var(--mut);font-weight:500">for Alexa+</span></div><div class="hdr-r"><span class="live" title="Every turn calls the live Fixwise MCP server">Live MCP · spec 2025-11-25 · AWS Lambda</span><span class="badge">Simulated Alexa+ experience · real MCP tool calls</span><button class="reset" id="skip" title="Demo clock: move this demo household forward 48 hours, to show SLA follow-up">⏩ +48 h</button><button class="reset" id="later" title="Keeps the household and its memory, drops this conversation, like asking Alexa again days later">New conversation</button><button class="reset" id="reset" title="Start a fresh demo household">New household</button></div></header>
<main>
 <section aria-label="Echo Show screen"><h1 class="sr">Fixwise simulated Alexa+ console</h1><div class="device"><div class="screen" id="screen"><div class="idle" id="idle"><div class="clock" id="clock"></div><div class="hint">Try: “Alexa, the geyser’s leaking and the street light outside has been out for two days.”</div></div><div class="cap" id="cap" aria-hidden="true"></div><div class="orb" id="orb" aria-hidden="true"></div><button class="stop" id="stop" type="button" aria-label="Stop speaking">■ Stop</button><button class="snd" id="snd" type="button">🔊 Tap to enable sound</button><iframe id="card" title="Fixwise visual card for the last answer" sandbox="allow-scripts"></iframe></div><div class="bar" id="bar" role="img" aria-label="Alexa light bar"></div><div class="sr" id="status" role="status" aria-live="polite"></div></div></section>
 <aside class="side show-trace" id="side" aria-label="Conversation">
  <div class="log" id="log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Conversation transcript"></div>
  <div class="yes" id="yes" role="group" aria-label="Confirm booking"><button class="y" data-say="Yes, book it">Yes, book it</button><button class="n" data-say="No, not yet">No</button></div>
  <div class="chips" id="chips" role="group" aria-label="Suggested replies"></div>
  <form id="f"><button type="button" class="mic" id="mic" title="Hold to talk, or tap to start and stop (Space)" aria-label="Talk to Alexa" aria-pressed="false"><span aria-hidden="true">🎙</span></button><label class="cam" title="Send a photo of the problem" role="button" tabindex="0" id="camb"><span aria-hidden="true">📷</span><span class="sr">Send a photo of the problem</span><input type="file" id="cam" accept="image/*" capture="environment"></label><input id="t" autocomplete="off" placeholder="Talk or type to Alexa…" aria-label="Message"><button class="send" type="submit">Send</button></form>
  <div class="foot"><label><input type="checkbox" id="tr" checked style="vertical-align:middle"> Show MCP tool calls</label><label><input type="checkbox" id="vo" checked style="vertical-align:middle"> Voice replies</label><span title="Captions are always on">CC on</span><span class="kbd" aria-hidden="true">/ type · T trace</span></div>
 </aside>
</main>
<script src="/console/app.js" defer></script></body></html>`;
}

// Console behaviour, served as /console/app.js so the page CSP can be script-src 'self' (no inline script).
export function consoleScript() {
  return `// The card iframe is sandboxed without allow-same-origin, so its origin is opaque ("null") and no targetOrigin
// other than '*' can reach it. Data goes only to that frame's own contentWindow, whose src we set; replies are
// accepted only when e.source is that window.
const toCard=(m)=>card.contentWindow&&card.contentWindow.postMessage(m,'*');
const $=id=>document.getElementById(id);const log=$('log'),bar=$('bar'),card=$('card');
let sid=localStorage.getItem('fx_sid2');async function ensureSid(force){if(sid&&!force)return sid;const r=await fetch('/console/api/session',{method:'POST'}).then(r=>r.json()).catch(()=>({}));sid=r.sid||null;if(sid)localStorage.setItem('fx_sid2',sid);return sid}
const tick=()=>{$('clock').textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})};tick();setInterval(tick,15000);
const STARTERS=["The geyser's leaking through the ceiling and the street light outside has been out for two days","Compare the quotes","Book the first one","Any news on the geyser?","Remember our budget is 2500 rand","Remember the stopcock is behind the garage","What have you done for me?"];
function chips(list){$('chips').innerHTML='';list.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s;b.onclick=()=>say(s);$('chips').appendChild(b)})}
chips(STARTERS.slice(0,3));
function add(cls,html){const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cardUri=null,cardData=null;
card.addEventListener('load',()=>{if(cardData)toCard({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:cardData}});card.classList.add('on');$('idle').style.display='none'});
function show(c){cardData=c.data;if(c.uri!==cardUri){cardUri=c.uri;card.classList.remove('on');card.src='/console/card?uri='+encodeURIComponent(c.uri)}else toCard({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:cardData}})}
let capT;function caption(t,totalMs){const c=$('cap');clearTimeout(capT);const parts=(t.split(/(?<=[.!?]["”]?)\\s+/)||[t]).map(x=>x.trim()).filter(Boolean);const chars=parts.reduce((n,p)=>n+p.length,0)||1;let i=0;const nx=()=>{if(i>=parts.length){c.classList.remove('on');return}const p=parts[i++];c.textContent=p;c.classList.add('on');capT=setTimeout(nx,totalMs?Math.max(900,totalMs*p.length/chars):1400+p.length*48)};nx()}
// Voice out: Amazon Polly neural (voice Ayanda, en-ZA) from /console/api/speak; browser speech only if Polly is unavailable.
const orb=$('orb');function state(x){bar.className='bar'+(x?' '+x:'');orb.className='orb'+(x?' '+x:'');$('stop').classList.toggle('on',x==='speak')}
// Mobile browsers (Chrome on Android, iOS Safari) only allow sound started inside a user gesture. Our reply audio
// arrives after an async fetch, outside the gesture, so we unlock ONE AudioContext inside every tap/keypress (resume +
// a silent buffer) and play Polly's MP3 through it. If it is still locked we show "Tap to enable sound".
const AC=window.AudioContext||window.webkitAudioContext;let actx=null,src=null,audio=null,speakGen=0,lastSpoken='';
function unlock(){try{if(AC){actx=actx||new AC();if(actx.state!=='running')actx.resume();const b=actx.createBuffer(1,1,22050),s=actx.createBufferSource();s.buffer=b;s.connect(actx.destination);s.start(0)}}catch(e){}
 try{if('speechSynthesis' in window&&!unlock.tts){unlock.tts=1;const u=new SpeechSynthesisUtterance(' ');u.volume=0;speechSynthesis.speak(u)}}catch(e){}
 if(actx&&actx.state==='running')$('snd').classList.remove('on')}
document.addEventListener('pointerdown',unlock,{capture:true});document.addEventListener('keydown',unlock,{capture:true});document.addEventListener('touchend',unlock,{capture:true,passive:true});
$('snd').onclick=()=>{unlock();$('snd').classList.remove('on');if(lastSpoken)speak(lastSpoken)};
function stopSpeaking(){speakGen++;if(src){try{src.stop()}catch(e){}src=null}if(audio){audio.pause();audio.src='';audio=null}if('speechSynthesis' in window)speechSynthesis.cancel();clearTimeout(capT);$('cap').classList.remove('on');state('')}
function chunks(t){const out=[];let cur='';for(const p of t.split(/(?<=[.!?])\\s+/)){if((cur+' '+p).length>560&&cur){out.push(cur);cur=p}else cur=(cur?cur+' ':'')+p}if(cur)out.push(cur);return out}
async function fetchVoice(text){const r=await fetch('/console/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:await ensureSid(),text})});if(!r.ok)throw new Error('tts '+r.status);return r.arrayBuffer()}
function browserSpeak(text,gen){if(!('speechSynthesis' in window)){caption(text);state('');return}const u=new SpeechSynthesisUtterance(text);const v=speechSynthesis.getVoices();u.voice=v.find(x=>/en-ZA/.test(x.lang))||v.find(x=>/en-GB/.test(x.lang))||v.find(x=>/^en/.test(x.lang))||null;u.rate=1.04;caption(text);state('speak');u.onend=u.onerror=()=>{if(gen===speakGen)state('')};speechSynthesis.speak(u)}
function playBuf(buf,text,gen){return new Promise(async res=>{
 if(actx&&actx.state==='running'){try{const ab=await actx.decodeAudioData(buf.slice(0));if(gen!==speakGen)return res(true);src=actx.createBufferSource();src.buffer=ab;src.connect(actx.destination);src.onended=()=>res(true);caption(text,ab.duration*1000);state('speak');src.start(0);return}catch(e){}}
 const url=URL.createObjectURL(new Blob([buf],{type:'audio/mpeg'}));audio=new Audio(url);audio.onended=audio.onerror=()=>{URL.revokeObjectURL(url);res(true)};audio.onloadedmetadata=()=>caption(text,isFinite(audio.duration)?audio.duration*1000:0);state('speak');
 audio.play().then(()=>{},()=>{URL.revokeObjectURL(url);res(false)})})}
async function speak(text){stopSpeaking();const gen=speakGen;if(!text)return;lastSpoken=text;if(!$('vo').checked){caption(text);return}
 const parts=chunks(text);let next=fetchVoice(parts[0]).catch(()=>null);
 for(let i=0;i<parts.length;i++){const buf=await next;if(gen!==speakGen)return;if(!buf){browserSpeak(parts.slice(i).join(' '),gen);return}
  next=i+1<parts.length?fetchVoice(parts[i+1]).catch(()=>null):null;
  const ok=await playBuf(buf,parts[i],gen);if(gen!==speakGen)return;
  if(!ok){$('snd').classList.add('on');caption(parts.slice(i).join(' '));state('');return}}
 state('')}
$('stop').onclick=stopSpeaking;
const NEXT={fixwise_report_problem:["Compare the quotes","Book the first one","Any news on the street light?"],fixwise_compare_quotes:["Book the first one","Book the cheapest","Book the fastest"],fixwise_book_repair:["Any news on the geyser?","What's open?","Cancel the booking"],fixwise_check_status:["Yes, escalate it","What's open?","It's fixed now"],fixwise_escalate:["Any news on the power?","What's open?","What have you done for me?"],fixwise_remember:["The kitchen tap is leaking","What do you remember?"],fixwise_diagnose_photo:["Compare the quotes","Book the first one","What's open?"]};
async function say(text){text=text.trim();if(!text)return;stopSpeaking();add('me',esc(text));$('t').value='';state('think');$('status').textContent='Alexa is thinking';const dots=add('dots','<i></i><i></i><i></i>');dots.className='dots';
 const ask=async()=>fetch('/console/api/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:await ensureSid(),text})}).then(r=>r.json()).catch(()=>({speech:'I could not reach Fixwise.'}));
 let r=await ask();if(r.error==='bad_session'){await ensureSid(true);r=await ask()}if(r.error==='rate_limited')r={speech:r.speech};
 dots.remove();const PL={'nova-lite':'Nova Lite planned','regex':'Fast router (fallback)','confirmation-guard':'Confirmation guard (code, not model)'};
 if(r.planner){const tr=document.createElement('div');tr.className='trace';tr.innerHTML='<span class="'+(r.planner==='regex'&&r.fallbackReason?'fb':'pl')+'">◆ '+esc(PL[r.planner]||r.planner)+(r.plannerMs?' · '+esc(r.plannerMs)+' ms':'')+(r.tokens?' · '+esc(r.tokens.in)+'→'+esc(r.tokens.out)+' tokens':'')+(r.fallbackReason?' · reason: '+esc(r.fallbackReason):'')+'</span>';log.appendChild(tr)}
 (r.calls||[]).forEach(c=>{const tr=document.createElement('div');tr.className='trace';tr.innerHTML='→ MCP tools/call <b>'+esc(c.tool)+'</b> '+esc(JSON.stringify(c.args||{}))+'  ·  <b>'+esc(c.ms)+' ms</b> · '+esc(c.transport||'')+(c.isError?' · <span class="fb">error</span>':'');log.appendChild(tr)});
 render(r)}
function render(r){const PL={'nova-lite':'Nova Lite planned','nova-lite-vision':'Nova Lite looked at the photo','regex':'Fast router (fallback)','confirmation-guard':'Confirmation guard (code, not model)'};
 if(r.planner==='nova-lite-vision'){const tr=document.createElement('div');tr.className='trace';tr.innerHTML='<span class="pl">◆ '+esc(PL[r.planner])+(r.plannerMs?' · '+esc(r.plannerMs)+' ms':'')+(r.tokens?' · '+esc(r.tokens.in)+'→'+esc(r.tokens.out)+' tokens':'')+'</span>';log.appendChild(tr);(r.calls||[]).forEach(c=>{const t2=document.createElement('div');t2.className='trace';t2.innerHTML='→ MCP tools/call <b>'+esc(c.tool)+'</b> '+esc(JSON.stringify(c.args||{}))+'  ·  <b>'+esc(c.ms)+' ms</b> · '+esc(c.transport||'')+(c.isError?' · <span class="fb">error</span>':'');log.appendChild(t2)})}
 add('ax','<b>ALEXA</b>'+esc(r.speech||''));$('status').textContent='';if(r.card)show(r.card);$('yes').classList.toggle('on',!!r.awaitingYes);chips(r.awaitingYes?[]:(NEXT[r.tool]||STARTERS.slice(0,3)));if(r.speech)speak(r.speech);else state('')}
$('f').onsubmit=e=>{e.preventDefault();say($('t').value)};document.querySelectorAll('.yes button').forEach(b=>b.onclick=()=>say(b.dataset.say));
$('tr').onchange=e=>$('side').classList.toggle('show-trace',e.target.checked);
$('later').onclick=async()=>{await fetch('/console/api/new-conversation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:await ensureSid()})}).catch(()=>{});log.innerHTML='';add('ax','<b>ALEXA</b>New conversation. Same household, so I still remember your issues, bookings and preferences. Try: “Any news on my geyser?”');chips(["Any news on my geyser?","What's open?","What do you remember?"])};
$('skip').onclick=async()=>{const r=await fetch('/console/api/skip-ahead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:await ensureSid(),hours:48})}).then(r=>r.json()).catch(()=>({}));if(r.ok){const d=document.createElement('div');d.className='trace';d.style.display='block';d.textContent='⏩ Demo clock moved forward '+r.hours+' hours (total +'+r.totalHours+' h). Real tool calls, simulated time.';log.appendChild(d);log.scrollTop=log.scrollHeight;chips(['Any news on the power?','Any news on the geyser?',"What's open?"])}};
$('reset').onclick=()=>{localStorage.removeItem('fx_sid2');speechSynthesis&&speechSynthesis.cancel();location.reload()};
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.key==='/'){e.preventDefault();$('t').focus()}else if(e.key==='t'||e.key==='T'){$('tr').click()}});
// Voice in: Web Speech API (Chrome, Edge, Android Chrome, Safari 14.1+). Hold to talk or tap to toggle; live interim
// transcript; pressing the mic while Alexa speaks stops her (barge-in). Firefox has no recognition: typing still works.
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const mic=$('mic');if(!SR){mic.title='Voice input needs Chrome, Edge or Safari. Type instead.';mic.setAttribute('aria-disabled','true');mic.style.opacity=.5}
let rec=null,interim=null,heldAt=0,finalText='';
function startRec(){if(!SR||rec)return;stopSpeaking();finalText='';rec=new SR();rec.lang='en-ZA';rec.interimResults=true;rec.continuous=false;mic.classList.add('on');mic.setAttribute('aria-pressed','true');state('listen');$('status').textContent='Listening';
 interim=add('me interim','…');
 rec.onresult=e=>{let fin='',tmp='';for(const r of e.results){(r.isFinal?(fin+=r[0].transcript):(tmp+=r[0].transcript))}finalText=fin;const x=(fin+tmp).replace(/^alexa,?\\s*/i,'');interim.textContent=x||'…';$('t').value=x};
 rec.onerror=e=>{if(e.error==='not-allowed'||e.error==='service-not-allowed'){add('ax','<b>ALEXA</b>I need microphone permission for voice. You can type instead.')}};
 rec.onend=()=>{mic.classList.remove('on');mic.setAttribute('aria-pressed','false');rec=null;if(interim){interim.remove();interim=null}const v=$('t').value.trim();if(v)say(v);else{state('');$('status').textContent=''}};
 try{rec.start()}catch{rec=null;state('')}}
function stopRec(){if(rec)rec.stop()}
mic.addEventListener('pointerdown',e=>{e.preventDefault();if(rec){stopRec();return}heldAt=Date.now();startRec();mic.setPointerCapture&&mic.setPointerCapture(e.pointerId)});
mic.addEventListener('pointerup',()=>{if(rec&&Date.now()-heldAt>450)stopRec()}); // held = push-to-talk; quick tap = toggle
mic.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();rec?stopRec():startRec()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')stopSpeaking();if(e.target.tagName!=='INPUT'&&e.code==='Space'&&!e.repeat&&e.target!==mic){e.preventDefault();rec?stopRec():startRec()}});
// Photo in: resized on the device to 1024 px JPEG, sent once to the live MCP tool, never stored on our side.
function shrink(file){return new Promise((res,rej)=>{const fr=new FileReader();fr.onerror=()=>rej(new Error('read'));fr.onload=()=>{const img=new Image();img.onload=()=>{const k=Math.min(1,1024/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext('2d').drawImage(img,0,0,c.width,c.height);res(c.toDataURL('image/jpeg',0.82))};img.onerror=()=>rej(new Error('bad image'));img.src=fr.result};fr.readAsDataURL(file)})} // data: URLs only, so the page CSP needs no blob: images
$('camb').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('cam').click()}});
$('cam').onchange=async e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(!f)return;stopSpeaking();let url;try{url=await shrink(f)}catch{add('ax','<b>ALEXA</b>I could not open that photo. Try a JPEG or PNG.');return}
 const note=$('t').value.trim();$('t').value='';const m=add('me',(note?esc(note):'Here’s a photo')+'<img class="photo" alt="Your photo" src="'+url+'">');state('think');$('status').textContent='Alexa is looking at the photo';const dots=add('dots','<i></i><i></i><i></i>');dots.className='dots';
 const send=async()=>fetch('/console/api/photo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:await ensureSid(),image_base64:url.split(',')[1],media_type:'image/jpeg',note})}).then(r=>r.json()).catch(()=>({speech:'I could not reach Fixwise.'}));
 let r=await send();if(r.error==='bad_session'){await ensureSid(true);r=await send()}if(r.error==='rate_limited')r={speech:r.speech};dots.remove();render(r)};
add('ax','<b>ALEXA</b>Hi, I\\'m Alexa with Fixwise. What\\'s broken at home or on your street? Tap the mic or type.');
`;
}
