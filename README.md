# TaskBrain — Agentic Capture Bot for Teams

> **Start with [HANDBOOK.md](HANDBOOK.md)** — the authoritative reference for
> architecture, deploy order, operations, iteration recipes, and the
> invariants any contributor (human or agent) must preserve. This README is
> the quick tour.

Voice/text capture (Teams or iMessage via Photon) → transcription → agentic triage → Azure "second brain" with vector recall.
Path 2 build: Bot Framework + Azure AI Foundry, everything in-tenant.

```
Teams (desktop / mobile voice clip)
        │  Activity (text or audio attachment)
        ▼
Azure Bot Service ──► App Service / Functions (this code)
        │
        ├── audio? ──► Azure AI Speech (fast transcription)
        │
        ▼
Triage (CHEAP model tier) — classify → extract → decide
        │
        ├── task        ──► Microsoft To Do (Graph API)
        ├── idea/note   ──► Blob (markdown, Obsidian-compatible) + Cosmos (metadata + embedding)
        ├── question    ──► vector recall over the brain, answer with sources
        ├── action      ──► AGENT LOOP (STANDARD tier) with unified tool registry:
        │                     native tools (brain, scheduler, To Do)
        │                     + MCP servers from config (Smartsheet PMO first)
        └── follow-up   ──► short-window session state (Cosmos, TTL)
        ▼
Adaptive Card confirmation back to Teams ("Filed as task ✓ due Friday")

Scheduler: jobs-as-data. schedule_job tool → Cosmos `jobs` doc (cron/one-off)
→ single orchestrator polls every 60s → runs the stored prompt through the
agent (PREMIUM tier) with full tools → proactive Teams message with the result.
```

## Modularity contracts

- **Integrations = config.** `config/mcp.servers.json` declares MCP servers
  (URL + token env var + tool allowlist). Smartsheet's hosted server
  (mcp.smartsheet.com) ships enabled. Adding Jira/ServiceNow/etc. later is a
  JSON entry, not code.
- **Models = app settings.** `config/model.routes.json` maps task classes
  (triage/agent/synthesis/digest) to env-var-named Foundry deployments, with
  cheap→standard escalation on triage parse failure. Retier without redeploying.
- **Cron from prompts = data.** "Every Friday at 4 summarize open Smartsheet
  risks" → the agent calls schedule_job → a Cosmos document. One orchestrator,
  no dynamic Azure resources, jobs listable/cancellable from chat.

## Design principles (the context-rot answer, encoded)

- **Stateless capture.** Each message is a closed transaction. The model sees:
  system prompt + current message + top-K retrieved notes. Never the Teams thread.
- **Memory = the store, not the chat.** Recall happens via vector search over
  Cosmos DB (NoSQL API vector indexing) — cheap at personal scale, upgrade path
  to Azure AI Search later without touching the bot.
- **Notes are plain markdown in Blob Storage** with YAML frontmatter and
  `[[wikilinks]]` — you can sync the container into an actual Obsidian vault
  any time. The brain is portable; Azure is the index, not the cage.
- **Follow-up window.** Last 5 turns kept in Cosmos with a 15-minute TTL so
  "actually make that Friday" works, then it evaporates.

## Repo layout

```
src/
  index.ts                 entry point, adapter, orchestrator startup
  bot.ts                   activity handler: text + voice attachments
  services/
    router.ts              model routing: task class → deployment, escalation
    agent.ts               triage (cheap tier) + agentic tool loop (standard)
    transcription.ts       Azure AI Speech fast transcription
    brain.ts               Blob markdown + Cosmos metadata/vectors + recall
    scheduler.ts           jobs-as-data: cron parsing, due-job queries
    graphTasks.ts          Microsoft To Do task creation via Graph
    session.ts             15-min rolling follow-up buffer
  tools/
    registry.ts            unified tool registry (native + MCP) + dispatch
    mcpClient.ts           MCP Streamable HTTP client, config-driven discovery
  jobs/
    orchestrator.ts        single 60s poller: due jobs → agent → proactive msg
config/
  mcp.servers.json         external integrations (Smartsheet enabled)
  model.routes.json        model tiers per task class
infra/main.bicep           all Azure resources (incl. jobs container)
teams-app/manifest.json    Teams app package
```

## Deploy (summary — full runbook in HANDBOOK.md §4)

0. `./scripts/bootstrap.sh <org>/<repo>` — one-time Entra/M365 setup:
   bot app registration + secret + Graph consent, CI identity with GitHub
   OIDC federation + RBAC, resource group, and it patches manifest/.env and
   prints every value for GitHub secrets and App Service settings.
1. Push to `main`: CI deploys Bicep (including Basic ACR, model deployments,
   Bot OAuth, and App Service settings), builds an immutable image inside ACR,
   restarts App Service onto that image, and checks `/healthz`.
2. Zip `teams-app/` (manifest + icons) and upload via Teams admin center or
   sideload. Pin it. Send it a voice memo.

## Cost profile (personal scale, ~30 captures/day)

| Line | Est./mo |
|---|---|
| Speech transcription | $5–10 |
| Chat model tokens (Sonnet 5 / GPT-5 class) | $10–30 |
| Embeddings | <$1 |
| Cosmos DB serverless + Blob | $5–15 |
| App Service B1 (or Functions consumption ≈ $0) | $0–13 |
| Azure Container Registry Basic | ~$5 |
| Bot Service (standard channel, S1 free tier for Teams) | $0 |

## Later upgrades (designed-for, not built)

- Swap Cosmos vector search → Azure AI Search agentic retrieval when the
  corpus grows past ~50k notes or you want hybrid/semantic ranking.
- Weekly "review" routine: timer-triggered Function that asks the agent to
  cluster the week's captures and DM you a digest.
- Graph subscription on a dedicated mailbox → email-in capture.

## CI/CD (GitHub → Azure)

Source of truth is GitHub; `.github/workflows/deploy.yml` deploys on push to
main using **OIDC federated credentials** (no service-principal secrets stored
in GitHub). Pipeline: build/typecheck → Bicep incremental deploy → remote image
build in ACR tagged with the Git SHA → App Service restart → `/healthz` smoke
test. App Service pulls through managed identity (`AcrPull`); no registry
password, application zip, Kudu extraction, or mutable deployment artifact is
used. Runtime secrets live as App Service settings, never in the repo.

## Observability & admin

Every component writes events to the `activity` container (30-day TTL):
captures, triage decisions, tool calls, model calls **with token counts per
deployment**, job runs, errors. `/admin` is gated by Entra Easy Auth: share
the URL; only people assigned to the **TaskBrain Admin** enterprise app can
sign in. The page shows today's stats, token spend by model, scheduled jobs,
agent memory, and the live event stream (auto-refresh 60s).

## Two memories, on purpose

- **Second brain** (`notes`): the USER's knowledge. Markdown + vectors, recall
  on demand.
- **Agent self-memory** (`agent-memory`): the AGENT's operational knowledge —
  preferences ("group summaries by project"), corrections/aliases ("'the
  register' = sheet 4821"), tool quirks, self-observations. Written via the
  remember_lesson tool when the user corrects it; injected into every agent
  prompt; capped at 40 lessons with automatic cheap-tier consolidation so the
  agent's self-knowledge can't itself become context rot.

## Agent topology: profiles now, multi-agent later

`config/agents.json` defines agents as data: persona + tool allowlist + model
route. `capture` (default), `pmo` (Smartsheet specialist), `digest`
(scheduled synthesis) ship today, all served by one agent loop in one process.
The seam is deliberate: if scale ever justifies true multi-agent (parallel
specialists, queue-based handoff), each profile lifts out to its own worker
unchanged — the definition format, tool registry, and activity log already
speak per-agent. Don't pay the coordination tax before the workload demands it.

## Production hardening (built in)

- **Write approvals.** MCP tools listed in a server's `confirmTools`
  (Smartsheet add_rows/update_rows by default) are never executed inline. The
  call parks as a pending action (1h TTL); the user replies `approve <id>` or
  `deny <id>`. An LLM can't write to the PMO system off a misheard voice memo.
- **Alerts.** Conversation references are stored per user, so the system can
  proactively message anyone: job owners get failure alerts, and
  ADMIN_AAD_OBJECT_ID gets admin alerts (budget trips, exhausted retries).
- **Budget guard.** DAILY_TOKEN_BUDGET caps the day's tokens; past it, all
  non-triage calls downgrade to the cheap tier until midnight UTC, with a
  one-time admin alert. Counter is rebuilt from the activity log every 5 min,
  so restarts/scale-out don't reset it.
- **Job claiming + retries.** Due jobs are claimed with etag-conditioned
  writes (scale-out safe, no double runs). Failures retry twice at 5-minute
  intervals, then alert owner + admin; recurring jobs skip to the next slot,
  one-offs disable.
- **App Insights** provisioned and wired via connection string for
  infra-level telemetry alongside the app-level activity log.
- **Tests + supply chain.** node:test suite runs in CI before deploy;
  Dependabot keeps npm and Actions dependencies patched weekly.
