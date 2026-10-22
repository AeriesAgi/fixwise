# Provenance

Fixwise is a new project started on 22 Oct 2026, inside the hackathon submission period (31 Aug to 23 Oct 2026).

| Source | Licence | Used | Where | Changed for Fixwise |
|---|---|---|---|---|
| CivicOps (Culltron) | MIT (vendor/civicops/LICENSE) | work-order catalogue JSON, deterministic classifier, audit log | vendor/civicops/, src/domain/civic.js | The classifier, priority rules, duplicate detection and hash-chained audit are ported from C# to JavaScript. The catalogue JSON is used unchanged. The municipal status feed is simulated and labelled as simulated. |

Everything else was written for Fixwise during the submission period: the OAuth 2.1 server, the MCP server, the console planner and MCP client, the domain (safety triage, compound reports, issues kept across sessions, two-step booking, preferences, memory search), the home-repair catalogue and pricing, the MCP Apps cards, the Lambda adapters, the advisor agent, the CDK stack, the judge client, the tests and the docs.
