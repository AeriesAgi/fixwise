# Demo video: "Fixwise for Alexa+" (target 2:45, hard limit under 3:00)

Format: 1080p screen capture of the simulated Alexa+ console (`/console` on the live AWS deployment), which is the rules' simulated-experience path. Every turn is a real call to the live MCP endpoint. There's no device footage, because the Alexa+ add-on tools are partner-only. The voice-over is Ash, or our own recorded voice. Music: none, or a track we made ourselves (the rules ban third-party music). No third-party logos apart from the Alexa+ and AWS names used in a descriptive way. All data is synthetic and the cards say so.

| # | Time | Picture | Words (VO / spoken) |
|---|---|---|---|
| 1 | 0:00–0:12 | A dark kitchen, water dripping from a ceiling bulge (stock-free: shoot it at home or use a generated still). Title card: **Fixwise** | VO: "When something breaks at home, you need three things fast: what to do right now, who fixes the street, and who fixes the house." |
| 2 | 0:12–0:40 | The console: the user clicks the mic and speaks. Captions appear on the screen. The light bar sweeps. The issue card appears with the safety banner. | User: "Alexa, the geyser's leaking through the ceiling and the street light outside has been out for two days." Alexa reads the safety step, the CO reference and the best quote. |
| 3 | 0:40–0:55 | Turn on "Show MCP tool calls". Zoom in on `tools/call fixwise_report_problem · 14 ms`. | VO: "One sentence, one MCP tool call to our own server. Safety first, then a municipal case from the CivicOps catalogue, then priced quotes in rand." |
| 4 | 0:55–1:20 | "Compare the quotes": the carousel card, Recommended / Cheapest tags. | Alexa reads three quotes. VO: "Urgent jobs weigh how fast someone can get there. Suspended suppliers never appear." |
| 5 | 1:20–1:45 | "Book the first one": the approval card ("Waiting for your yes"). Pause. "Yes, book it." The card shows Booked ✓. | VO: "Nothing is booked until you say yes. The confirmation is tied to that exact quote, works once and expires in fifteen minutes." |
| 6 | 1:45–2:05 | Cut to "the next day" (a title). A new session: "Any news on the geyser?" The status card, with the advisor note. | VO: "Fixwise remembers your household across sessions. In the background, Amazon Nova Lite on Bedrock wrote that advice, so the voice reply never waits." |
| 7 | 2:05–2:25 | Terminal: `curl -i` the live `/mcp` URL returns 401 with no WWW-Authenticate (Alexa+'s rule). Then the architecture diagram (docs/media/architecture.png): Lambda Function URL → Lambda → DynamoDB; SQS → advisor Lambda → Bedrock Nova Lite; console: Nova Lite plans → MCP client → /mcp. Terminal: `npm run e2e` showing p50 10 ms on Lambda. | VO: "It's an MCP server on spec 2025-11-25 over Streamable HTTP, with OAuth 2.1 account linking built to Alexa's rules, running on AWS Lambda. Typical tool calls answer in milliseconds, far inside Alexa's 500 millisecond budget." |
| 8 | 2:25–2:40 | "What have you done for me?": "Audit chain verified." | VO: "Every action goes into a tamper-evident chain, so the household can see exactly what was done." |
| 9 | 2:40–2:48 | End card: Fixwise · github URL · "Built on AWS". | VO: "Fixwise. Tell Alexa what's broken. We'll get it fixed." |

Recording checklist: clear the browser localStorage so the household is fresh; set the console voice to en-GB/en-ZA; turn the trace on only for shot 3; keep the cursor still; record at 1440×900 and crop to 16:9; keep one take per shot.
Before recording: press **New household** for a clean state, the tool-call trace is on by default (press **T** to hide it). Leave captions on; they make the video readable with the sound off. Show the browser URL bar once in shot 2 so judges can see it's the live AWS URL.


**Draft cut (22 Oct):** recorded headless from https://alexa.culltron.app/console by `scripts/record-demo.py`. It runs 2:10, is 1080p, has captions on and is silent, so it's ready for the voice-over. Shots 1, 6, 7 and 9 are title cards, a real `curl` of the live 401 and the architecture diagram.
