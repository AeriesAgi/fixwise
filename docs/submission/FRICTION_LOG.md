# Friction log (for the up-to-10% bonus)

Entries recorded while building. The format follows the rules: task, steps, expected vs actual, severity, workaround, suggestion.

### 1. Alexa+ 401 rule vs the MCP authorization spec
- **Task:** make one MCP server work for Alexa+ and for generic MCP clients.
- **Steps:** read the Alexa+ MCP QuickStart and the MCP 2025-11-25 authorization spec.
- **Expected:** one consistent unauthenticated response.
- **Actual:** the MCP spec says servers MUST send `WWW-Authenticate` with `resource_metadata` on 401. Alexa+ requires 401 *without* that header.
- **Severity:** Medium (account linking fails silently if you follow the MCP spec).
- **Workaround:** two mounts on one OAuth server. `/mcp` sends `WWW-Authenticate` with `resource_metadata` (spec); `/alexa/mcp` sends none (Alexa+). The Alexa+ skill points at `/alexa/mcp`.
- **Suggestion:** say explicitly in the QuickStart that this deviates from MCP 2025-11-25 §Authorization, and say whether a header with `resource_metadata` only is tolerated.

### 2. No Dynamic Client Registration on the Alexa+ side
- **Task:** reuse an existing MCP OAuth server that relies on RFC 7591 DCR.
- **Expected:** Alexa+ registers itself as MCP clients usually do.
- **Actual:** DCR and CIMD are listed as "not supported yet", so the client must be pre-registered with redirect URIs that only the CLI reveals.
- **Severity:** Medium.
- **Workaround:** a static client list in an SSM SecureString, and the deploy script re-run once the redirect URIs are known.
- **Suggestion:** publish the Alexa redirect URI patterns per region in the docs, so servers can be configured before onboarding.

### 3. 500 ms round-trip budget with LLM-backed tools
- **Task:** use Bedrock reasoning inside a tool.
- **Expected:** guidance on asynchronous tools (MCP tasks) under Alexa+.
- **Actual:** the docs give the budget, but not whether MCP 2025-11-25 tasks or progress notifications are supported.
- **Severity:** Medium.
- **Workaround:** every MCP tool is deterministic and fast. Nova Lite is used only for console planning (about 650 ms) and for an advisor note that goes through SQS and shows up on the next turn.
- **Suggestion:** state which MCP features Alexa+ honours (tasks, progress, elicitation, sampling).

### 4. MCP Apps on Alexa devices
- **Task:** show cards on Echo Show.
- **Actual:** the docs point to `@modelcontextprotocol/ext-apps`, but there is no Alexa-specific viewport or size guidance.
- **Severity:** Low.
- **Workaround:** responsive cards tested at 16:10, with large type.
- **Suggestion:** publish a device viewport table and a local preview host.

### 5. Bedrock "account is being verified" on a new account
- **Task:** call Nova Lite from the advisor.
- **Actual:** AccessDeniedException ("Your account is currently being verified… less than 2 hours"). Access worked about an hour later, and the console showed no status.
- **Severity:** Medium. **Workaround:** a deterministic fallback note. **Suggestion:** show the verification state in the Bedrock console and in `sts`/`account` APIs.

### 6. Lambda reserved concurrency on new accounts
- **Task:** cap the public MCP Lambda with reserved concurrency (cost safety).
- **Actual:** CREATE_FAILED, "decreases account's UnreservedConcurrentExecution below its minimum value of [10]". The account limit is 10, so nothing can be reserved, and the stack is left in ROLLBACK_COMPLETE, which needs a manual delete.
- **Severity:** Medium. **Workaround:** drop the reservation and rely on per-user rate limits. **Suggestion:** have CDK warn at synth, or have the error name the account quota.

### 7. The Alexa AI CLI setup page doesn't say it's partner-only
- **Task:** follow "Set Up Your Development Environment" (developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html) to install `@alexa-ai/cli` and run `alexa-ai configure`.
- **Expected:** a free developer account plus an AWS account is enough, which is what the page's "Required accounts" list says.
- **Actual:** the page never says the tools are gated. Only the add-ons home page and the hackathon FAQ say the CLI, MCP Toolkit and Web Simulator are "in preview and available to select partners only". Step 1 says "the AWS account that you provided to the Alexa Solutions Architect", but a hackathon entrant has no Solutions Architect.
- **Severity:** High: it cost a new developer account, an IAM setup and about an hour before we hit the wall. **Workaround:** none for entrants. We demo through our own simulated Alexa+ console against the live MCP server, as the rules allow. **Suggestion:** put a "Preview, select partners only" banner at the top of every add-on setup page, and give hackathon entrants a sandbox path (or the Web Simulator).

### 8. `AddOn3PDeveloperToolsRead` role assumption is refused, with no next step
- **Task:** Step 2, `aws sts get-caller-identity --profile alexa-ai`, assuming `arn:aws:iam::<amazon-account>:role/AddOn3PDeveloperToolsRead`, which is needed for the CodeArtifact npm registry that serves the CLI.
- **Actual:** `AccessDenied ... is not authorized to perform: sts:AssumeRole`. Our caller has AdministratorAccess, so the refusal comes from the role's trust policy on Amazon's side: our account isn't allowlisted. The error looks exactly like a policy mistake on the caller's side. Another entrant reported the same error on the Amazon developer forum.
- **Severity:** High (blocking). **Workaround:** none. **Suggestion:** say on the page that the trust policy is allowlist-based, and that you must send your account ID to your Alexa contact before Step 2 will work.

### 9. A lookalike `alexa-ai` package on public npm
- **Task:** find the CLI after `npm install -g @alexa-ai/cli` returned 404 on the public registry.
- **Actual:** `npm view alexa-ai` resolves to an unrelated third-party package, an "AI engine for the Alexa WhatsApp bot". A developer who drops the scope gets someone else's code installed globally. We did not install it.
- **Severity:** Medium (supply-chain risk). **Suggestion:** publish a public placeholder for `@alexa-ai/cli` that points to the access process, warn about unscoped lookalikes in the docs, and consider an npm name dispute.

### 10. MCP Inspector 2.x needs Node 22.19+, and the quick start doesn't say so
- **Task:** prove the live server with `npx @modelcontextprotocol/inspector --cli ... --transport http --header "Authorization: Bearer ..."` (22 Oct).
- **Actual:** on Node 20.19, npm printed `EBADENGINE` warnings for inspector 2.12.0, commander 15 and undici 8 (they need Node ≥ 22.12 or 22.19). It still worked, but a judge on Node 20 could reasonably think the server was at fault.
- **Severity:** Low. **Workaround:** our zero-dependency `judge.mjs` runs on Node 18+, and we published our own Inspector transcript (`evidence-mcp-inspector.txt`). **Suggestion:** state the Node minimum next to the `npx` line in the Inspector README, and fail fast with a clear message instead of warnings.

### 11. Nova Lite tool use: split reports and dropped halves of compound requests
- **Task:** have Nova Lite (Converse, tool use) plan Alexa-style turns over the 11 Fixwise MCP tools.
- **Expected:** one `fixwise_report_problem` call for "the fridge is buzzing and the kitchen tap drips", and two calls for "remember our budget is 2000 rand and compare the fridge quotes".
- **Actual:** in testing at temperature 0, the first came back as two report calls (each with half of the sentence). The second came back as only `fixwise_compare_quotes`, and the budget was dropped. Adding an explicit example to the system prompt fixed the first but not reliably the second.
- **Severity:** Medium (silent loss of a user instruction). **Workaround:** deterministic post-planning passes in `src/console/planner.js` and `api.js`: merge duplicate reports into the user's full sentence, add a missed `fixwise_remember` when the utterance states a budget or preference, and drop any side-effecting tool the user didn't ask for. All are covered by tests. **Suggestion:** document Nova's parallel tool-call behaviour, and publish a recommended pattern for compound user intents in the Nova tool-use guide.

### 12. An async enrichment job can silently undo a user's action
- **Task:** attach the background advisor note to an issue after the voice reply.
- **Actual:** our worker loaded the household, called Bedrock for about 1–2 s, then saved the whole record. A booking confirmed during that window was overwritten. Our own one-command judge client caught it: status said "isn't booked yet" right after "Booked."
- **Severity:** High for us (a lost purchase confirmation), and a likely trap for any MCP server that does background work. **Workaround:** the worker now writes only to its own key (`adv:<household>:<issue>`), and reads merge it in. A regression test covers the race. **Suggestion:** Alexa+ add-on docs should recommend MCP tasks or idempotent side writes for background work, and warn against read-modify-write of shared state from async workers.
