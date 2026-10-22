#!/usr/bin/env python3
"""End-to-end browser smoke test of the live console (phone 412 px and desktop 1280 px).
Usage: scripts/e2e-smoke.py [base_url] [shots_dir]. Exits non-zero on any failure."""
import asyncio, re, sys, os
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'https://alexa.culltron.app'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
import glob
CHROME = os.environ.get('SMOKE_CHROME') or next(iter(sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell')))[::-1]), None) or ('/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None)  # default: Playwright's bundled headless shell (more stable than desktop Chrome)

async def run(p, name, vp, mobile):
    b = await p.chromium.launch(executable_path=CHROME, args=['--mute-audio', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'])
    ctx = await b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    fails = []
    def check(cond, what):
        print(('  ok   ' if cond else '  FAIL ') + f'[{name}] {what}')
        if not cond: fails.append(what)
    async def shot(tag):
        if SHOTS:
            await pg.mouse.wheel(0, -5000); await pg.wait_for_timeout(600)
            await pg.screenshot(path=f'{SHOTS}/final-{name}-{tag}.png')
    async def say(t):
        n = await pg.locator('.msg.ax').count()
        await pg.locator('#t').fill(t); await pg.locator('.send').click()
        for _ in range(80):
            if await pg.locator('.msg.ax').count() > n: break
            await pg.wait_for_timeout(250)
        await pg.wait_for_timeout(1500)
        out = (await pg.locator('.msg.ax').last.inner_text()) if await pg.locator('.msg.ax').count() > n else ''
        if re.search(r'</?[a-z]+>', out): check(False, 'no markup leaked into speech: ' + out[:80])
        return out
    async def card():
        try: return await pg.frame_locator('#card').locator('body').inner_text(timeout=5000)
        except Exception: return ''
    await pg.goto(BASE + '/console'); await pg.wait_for_timeout(1500)
    check(not errs, 'console script loads without errors')
    r = await say('Can you send a WhatsApp to my brother?'); check(re.search(r"can't|cannot|can not|only (help|handle)|here to (assist|help)|not something|what needs fixing|what's broken", r, re.I) is not None and not re.search(r'\bsent\b', r), 'out-of-scope request refused honestly: ' + r.replace('\n', ' ')[:90])
    r = await say('My geyser is leaking in Melville'); c = await card()
    check('Switch the geyser off' in r and 'R2,967' in c, 'geyser report: safety step + quotes card'); await shot('quotes')
    r = await say('Why is the first one more expensive?'); c = await card()
    check('more than' in r and 'What you pay for' in c, 'cost explanation: speech + table'); await shot('explain')
    await say('Book the best one'); r = await say('Yes, book it'); c = await card()
    check(r.startswith('ALEXA\nBooked') or 'Booked.' in r, 'booking confirmed')
    check(re.search(r'(Mon|Tue|Wed|Thu|Fri|Sat), \d+ \w+, (0[7-9]|1[0-6]):\d\d–(1[0-7]|0[8-9]):\d\d', c) is not None, 'visit window within 07:00–17:00, Mon–Sat')
    check('.ics' in c.lower() or 'calendar' in c.lower(), 'calendar file offered'); check('load-shedding' in c.lower(), 'load-shedding tip shown'); await shot('booked')
    sk = pg.locator('button:has-text("+48 h")').first
    for _ in range(2): await sk.click(); await pg.wait_for_timeout(1500)
    r = await say('Any news on the geyser?'); check('Rate them' in r or 'rate' in r.lower(), 'rating asked after visit'); await shot('rate-ask')
    r = await say('Not fixed, 2 stars'); check("won't suggest them again" in r, 'low rating: supplier avoided'); await shot('rated')
    r = await say('Share this with my landlord'); c = await card()
    check("can't send it" in r and 'Landlord view' in c, 'landlord link: shown, not sent'); check(not re.search(r'Best quote[^\n]*\n?[^\n]*AquaFix', c), 'avoided supplier no longer shown as best quote'); await shot('landlord-card')
    url = await pg.frame_locator('#card').locator('.lnk').first.get_attribute('data-u')
    lp = await ctx.new_page(); resp = await lp.goto(url); txt = await lp.inner_text('body')
    check(resp.status == 200 and 'read-only' in txt, 'landlord page opens read-only')
    if SHOTS: await lp.screenshot(path=f'{SHOTS}/final-{name}-landlord-page.png', full_page=True)
    bad = await lp.goto(re.sub(r's=...', 's=xxx', url)); check(bad.status == 404, 'tampered landlord link rejected'); await lp.close()
    r = await say('The street light outside has been out for two days in Melville'); check(re.search(r'municipal|City|case|reference', r, re.I) is not None, 'street light: municipal case'); await shot('municipal')
    await pg.select_option('#lang', 'af'); await pg.wait_for_timeout(300)
    r = await say('My kombuiskraan lek'); c = await card(); check('Leaking pipe' in c and len(r) > 10, 'Afrikaans turn translated by Nova'); await pg.wait_for_timeout(800); await shot('afrikaans')
    await pg.select_option('#lang', 'en')
    check(not errs, 'no page errors during run' + (': ' + errs[0][:120] if errs else ''))
    await b.close(); return fails

async def main():
    allf = []
    async with async_playwright() as p:
        for name, vp, m in [('phone412', {'width': 412, 'height': 915}, True), ('desktop', {'width': 1280, 'height': 860}, False)]:
            for attempt in range(4):
                try: allf += await run(p, name, vp, m); break
                except Exception as e:
                    print(f'  retry [{name}] {type(e).__name__}: {str(e)[:160]}')
                    if attempt == 3: allf.append(f'{name}: crashed')
    print('E2E SMOKE ' + ('PASSED' if not allf else f'FAILED ({len(allf)})'))
    sys.exit(1 if allf else 0)
asyncio.run(main())
