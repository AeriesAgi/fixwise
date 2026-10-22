---
name: fixwise-addon
description: Run, test, deploy and onboard Fixwise (an Alexa+ MCP add-on) and extend its tools. Use when asked to run Fixwise locally, deploy it to AWS, connect it to Alexa+, demo the simulated console, or add a new household-repair tool.
---
# Fixwise add-on skill

## Run and check locally
1. `npm ci`, then create `.dev.vars` as in the README (a static client; the secret lives in a 0600 file).
2. `npm start`, then open `http://127.0.0.1:8787/console` for the simulated Alexa+ console.
3. `npm test` runs the unit and integration tests. `npm run e2e` (with CLIENT_ID, CLIENT_SECRET and REDIRECT_URI set) runs account linking plus the official MCP SDK client and prints latency.

## Alexa+ rules you must keep
- `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata=…` (MCP spec); `/alexa/mcp` returns 401 with no header (Alexa+ rule). PRM and AS metadata exist, and S256 is advertised.
- The client is pre-registered in `FIXWISE_CLIENTS` (no DCR or OIDC). `resource` is required at the token step.
- The voice path must stay under 500 ms: any slow work goes through `ctx.enqueue` (SQS → advisor Lambda → Nova Lite). Its result is written to its own key (`putAdvice`), never back into the household record, and is shown on the next turn.

## Prove it live (judges)
`curl -fsSL https://alexa.culltron.app/judge.mjs -o judge.mjs && node judge.mjs` runs the 401 check, OAuth discovery, PKCE linking (client `fixwise-judge`), MCP initialize and the demo story. Add `--interactive` to call tools yourself.

## Deploy
`BUDGET_EMAIL=... ./scripts/deploy.sh`. It needs AWS credentials and `.deploy/households.json`, and is idempotent. Optional, and not used in production: `./scripts/agent-image.sh` (needs Docker), then re-run with `AGENT_IMAGE_URI=...` to move the advisor to AgentCore Runtime.

## Onboard to Alexa+
`alexa-ai configure` (the owner's Login with Amazon), then `alexa-ai new mcp --name "Fixwise" --locale en-US --mcp-server-url https://<your-domain>/alexa/mcp`, then add the redirect URIs to `.deploy/alexa_redirects`, re-run deploy.sh, then `alexa-ai deploy`.

## Add a tool
1. Add the schema to `src/mcp/tools.js`: a description written for Alexa+ reasoning, a scope, annotations, and an optional `ui` card.
2. Implement `(env, h, args, ctx)` in `src/domain/fixwise.js`. Return `say(text, structured, {ui})`. Call `audit()` for anything that changes state.
3. Map it in `HANDLERS` (`src/mcp/server.js`). The console's Nova Lite planner picks it up from `tools/list` automatically. Add a regex fallback intent in `src/console/intents.js`, and add an intent guard in `src/console/planner.js` (`INTENT`) if the tool has side effects.
4. Add a test in `test/mcp.test.js`, plus a planner test with a fake `env.BEDROCK` in `test/planner.test.js`.

## Never
- Never let a model set `confirm` or `approval_id`. Never call `fixwise_book_repair` with `confirm=true` unless the customer said yes in this conversation.
- Never log headers, query strings, tokens or passcodes. Never commit `.dev.vars` or `.deploy/`.
