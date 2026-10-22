import asyncio, html, time, sys
from pathlib import Path
from playwright.async_api import async_playwright
U="https://alexa.culltron.app"
MEDIA=Path(__file__).resolve().parent.parent/"docs"/"media"
SHOTS=str(MEDIA)+"/"
CURL=open('curl.txt').read()
ARCH=(MEDIA/"architecture.png").as_uri()
CSS="body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 20% -10%,#12303a 0,transparent 60%),#070d12;color:#eef6f4;font:20px system-ui,sans-serif;text-align:center}h1{font-size:84px;margin:0 0 10px;letter-spacing:-.02em}p{color:#8aa5a6;max-width:1100px;font-size:28px;line-height:1.4}.k{color:#3ddc97}"
def card(h): return "data:text/html,"+ "<style>"+CSS+"</style>"+h
log=[]
async def say(p,text,wait):
    t0=time.time()
    await p.fill('#t','');await p.type('#t',text,delay=38);await p.keyboard.press('Enter')
    n=await p.locator('.msg.ax').count()
    for _ in range(150):
        if await p.locator('.msg.ax').count()>n: break
        await p.wait_for_timeout(100)
    reply=(await p.locator('.msg.ax').last.inner_text()).replace('ALEXA\n','')
    log.append((text,round((time.time()-t0)*1000),reply[:160])); await p.wait_for_timeout(wait)
    return reply
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        c=await b.new_context(viewport={'width':1440,'height':810},record_video_dir='raw',record_video_size={'width':1440,'height':810})
        p=await c.new_page()
        await p.goto(card("<h1>Fixwise</h1><p>When something breaks at home you need three things fast: <span class=k>what to do right now</span>, who fixes the street, and who fixes the house.</p>"));await p.wait_for_timeout(9000)
        await p.goto(U+'/console');await p.wait_for_timeout(1500)
        await p.evaluate("localStorage.clear()");await p.reload();await p.wait_for_timeout(2500)
        await p.uncheck('#vo')
        await p.screenshot(path=SHOTS+'console-0-idle.png')
        r=await say(p,"The geyser's leaking through the ceiling and the street light outside has been out for two days",9000)
        await p.screenshot(path=SHOTS+'console-1-report.png')
        await p.keyboard.press('Escape');await p.locator('body').click(position={'x':5,'y':5});await p.keyboard.press('t');await p.wait_for_timeout(4500)
        await say(p,"Compare the quotes",10000);await p.screenshot(path=SHOTS+'console-2-quotes.png')
        await p.locator('body').click(position={'x':5,'y':5});await p.keyboard.press('t')
        await say(p,"Book the first one",6000);await p.screenshot(path=SHOTS+'console-3-confirm.png')
        await p.click('.yes .y');await p.wait_for_timeout(9000)
        await p.screenshot(path=SHOTS+'console-3b-booked.png')
        await p.goto(card("<h1 style='font-size:64px'>The next day</h1>"));await p.wait_for_timeout(3500)
        await p.goto(U+'/console');await p.wait_for_timeout(2000);await p.uncheck('#vo')
        await say(p,"Any news on the geyser?",11000);await p.screenshot(path=SHOTS+'console-4-status.png')
        await p.goto(card("<pre style='text-align:left;font:17px ui-monospace,monospace;color:#cfe;background:#05080b;padding:28px;border-radius:16px;max-width:1300px;white-space:pre-wrap'>"+html.escape(CURL)+"</pre><p>401, no <span class=k>WWW-Authenticate</span>, PKCE <span class=k>S256</span>: Alexa+'s account-linking rules.</p>"));await p.wait_for_timeout(9000)
        await p.goto(card(f"<img src='{ARCH}' style='max-width:92vw;max-height:78vh;border-radius:12px'><p>MCP spec 2025-11-25 · Streamable HTTP · AWS Lambda · Bedrock Nova · p50 10 ms server-side</p>"));await p.wait_for_timeout(11000)
        await p.goto(U+'/console');await p.wait_for_timeout(1500);await p.uncheck('#vo')
        await say(p,"What have you done for me?",11000);await p.screenshot(path=SHOTS+'console-5-audit.png')
        await p.goto(card("<h1>Fixwise</h1><p>Tell Alexa what's broken. We'll get it fixed.</p><p style='font-size:22px'>alexa.culltron.app · github.com/AeriesAgi/fixwise · Built on AWS · simulated Alexa+ experience, live MCP server · synthetic data</p>"));await p.wait_for_timeout(7000)
        vp=await p.video.path();await c.close();await b.close()
        print("VIDEO",vp)
        for l in log: print("TURN",l)
asyncio.run(main())
