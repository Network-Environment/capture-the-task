# TaskBrain — Agentic Capture Bot for Teams

> **Start with [HANDBOOK.md](HANDBOOK.md)** — the authoritative reference for
> architecture, deploy order, operations, iteration recipes, and the
> invariants any contributor (human or agent) must preserve. This README is
> the quick tour.

Voice/text capture (Teams or iMessage via Photon) → transcription → structured
intent interpretation → deterministic risk policy → conversation, clarification,
capture, retrieval, or approved action.
Path 2 build: Bot Framework + Azure AI Foundry, everything in-tenant.

```
Teams (desktop / mobile voice clip) or iMessage
        │
        ▼
gateway role (TASKBRAIN_ROLE=gateway)
  bot.ts / channels/photon.ts acknowledge, then enqueue
  Teams voice is transcribed here before the request is queued
        │
        ▼
Cosmos agent-requests
        │
        ▼
worker role → requestWorker → processCapture (pipeline.ts)
        │
        ▼
Intent (CHEAP model tier) — interpret → policy → decide
        │
        ├── task        ──► Microsoft To Do (Graph API)
        ├── idea/note   ──► Blob (markdown, Obsidian-compatible) + Cosmos (metadata + embedding)
        ├── question    ──► private brain + shared execution-graph recall
        ├── action      ──► AGENT LOOP (STANDARD tier) with unified tool registry:
        │                     native tools (brain, scheduler, execution graph, Tavily web search)
        │                     + MCP servers from config (Smartsheet PMO first)
        │                     reads in one response run together; writes stay in order
        └── follow-up   ──► private thread (24 turns, 24h) plus one untrusted summary
        ▼
result stored on the request
        │
        ▼
gateway delivery pump → Adaptive Card (Teams) or plain text (iMessage)

Same image, three App Service roles: gateway, worker, and admin.
Scheduler: jobs-as-data on the worker. schedule_job tool → approval preview →
Cosmos `jobs` doc (cron/one-off + immutable read-only tool envelope) →
orchestrator polls every 60s → proactive message with the result.
Meeting ingest is a separate Functions timer, not a chat job.
```

## Modularity contracts

- **Integrations = config.** `config/mcp.servers.json` declares MCP servers
  (URL or `urlEnv` + token env var + tool allowlist). Smartsheet's hosted server
  (mcp.smartsheet.com) ships enabled. Adding another system later is a
  JSON entry, not code, and only after unmet requests show the org needs it.
  Native `web_search` and public page reads use Tavily, not a browser.
- **Models = app settings.** `config/model.routes.json` maps task classes
  (triage/agent/synthesis/digest) to env-var-named Foundry deployments, with
  cheap→standard escalation on triage parse failure. Retier without redeploying.
- **Cron from prompts = data.** "Every Friday at 4 summarize open Smartsheet
  risks" → the agent calls schedule_job → a Cosmos document. One orchestrator,
  no dynamic Azure resources, jobs listable/cancellable from chat.

## Design principles (the context-rot answer, encoded)

- **Bounded conversational context.** The model sees the current message, at
  most 24 structured turns on the private thread, one rewritten summary of
  older turns, and explicitly retrieved data. It never sees the whole Teams
  thread. The summary is untrusted conversation data, not authorization.
  Ambiguous mutations produce one focused question.
- **Memory = the store, not the chat.** Recall happens via vector search over
  Cosmos DB (NoSQL API vector indexing) — cheap at personal scale, upgrade path
  to Azure AI Search later without touching the bot.
- **Notes are plain markdown in Blob Storage** with YAML frontmatter and
  `[[wikilinks]]` — you can sync the container into an actual Obsidian vault
  any time. The brain is portable; Azure is the index, not the cage.
- **Follow-up window.** The private thread keeps 24 turns for 24 hours.
  Undo and an unanswered question expire after 15 minutes.
- **Shared execution is explicit.** TaskBrain-owned projects/tasks form a
  typed graph with people, meeting sources, dependencies, and reviewed
  relationships. Personal notes and ordinary captures never auto-publish.

## Repo layout

```
src/
  index.ts                 TASKBRAIN_ROLE switch: admin | gateway | worker
  runtime/
    gateway.ts             Teams + iMessage ingress, delivery pump, signed webhooks, /healthz
    worker.ts              request worker + job orchestrator
    admin.ts               /admin portal and control-plane APIs
    correlation.ts         trace, run, and per-run cost scope
    tracing.ts             OpenTelemetry spans for model and tool calls
  bot.ts                   Teams adapter: normalize, transcribe, enqueue
  channels/                Photon iMessage, delivery, acknowledgements, signed webhooks
  pipeline.ts              processCapture; called by the worker, not adapters
  services/
    requestQueue.ts        Cosmos agent-requests
    requestWorker.ts       claim → processCapture → store result
    requestDeliveryWorker.ts  gateway pump back to the conversation
    router.ts              model routing, budget guard, per-run cost ceiling
    agent.ts               intent (cheap tier) + agentic tool loop (standard)
    promptBudget.ts        fit one run's prompt to the route's context window
    modelCost.ts           list-price USD estimate per model call
    transcription.ts       Azure AI Speech fast transcription
    brain.ts               Blob markdown + Cosmos metadata/vectors + recall
    scheduler.ts           jobs-as-data: cron parsing, due-job queries
    graphTasks.ts          Microsoft To Do task creation via Graph
    session.ts             24-turn / 24h private thread, 15-min undo and questions
  tools/
    registry.ts            unified tool registry (native + MCP) + dispatch
    validateArgs.ts        native tool arguments checked against their schema
    mcpClient.ts           MCP Streamable HTTP client, config-driven discovery
    webResearch.ts         native Tavily search + public page extract
  jobs/
    orchestrator.ts        worker 60s poller: due jobs → agent → proactive msg
  graph/
    types.ts               projects/tasks/people/meetings + typed edges
    store.ts               scoped Cosmos CRUD, hybrid recall, traversal
    project.ts             deterministic org/meeting/commitment projection
    validation.ts          relationship, visibility, cycle, and size guards
  admin/client/graph.ts     bundled Cytoscape execution graph UI
config/
  mcp.servers.json         external integrations (Smartsheet)
  model.routes.json        model tiers per task class
infra/main.bicep           all Azure resources (incl. jobs container)
scripts/backfill-graph.ts  dry-run/apply migration of shared source records
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
   sideload. Pin the personal app. To @mention in a channel, add TaskBrain
   to that team. Send it a voice memo.

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
- Graph subscription on a mailbox → email-in capture. `POST /api/hooks/graph`
  already accepts the validation handshake and clientState-checked
  notifications; it does not create the subscription or run the agent.
- App Service deployment slots, once the plan is Standard or higher. B1 has none.

## CI/CD (GitHub → Azure)

Source of truth is GitHub; `.github/workflows/deploy.yml` deploys on push to
main using **OIDC federated credentials** (no service-principal secrets stored
in GitHub). Pull requests run the same build and `npm test` via
`.github/workflows/pr.yml` and do not deploy. `intent-eval.yml` stays a
nightly job against production Foundry settings. Pipeline: build/typecheck →
Bicep incremental deploy → remote image
build in ACR tagged with the Git SHA → App Service restart → `/healthz` smoke
test. App Service pulls through managed identity (`AcrPull`); no registry
password, application zip, Kudu extraction, or mutable deployment artifact is
used. Runtime secrets live as App Service settings, never in the repo.

## Observability & admin

Every component writes events to the `activity` container (30-day TTL):
captures, triage decisions, tool calls, model calls **with token counts,
estimated USD, and trace id**, job runs, meeting discovery/summary, webhook
receipts, and errors. A queued request, its model calls, and its tool calls
share one trace. When Application Insights is configured, each model call and
tool call is also an OpenTelemetry span. Origin, channel, and text/voice
input mode are recorded separately.
`/admin` is gated by Entra Easy Auth and app roles. **Admin** can read and
mutate the portal; **Reader** can view every section but cannot queue meeting
summaries, edit the org directory, or mutate the execution graph. Initial
assignments are Adam (Admin), Valerie (Reader), and Joseph Ryan (Reader).
Teams transcript metadata is discovered automatically, but an Admin selects
which meetings consume tokens for summary/embedding. The page shows
today's stats, token spend by model/origin, scheduled jobs, agent memory, and
the live event stream (auto-refresh 60s). **Execution graph** is the
interactive project/task relationship map (no forced refresh). **Org** is the maintainable
directory of teams, people, and roles so the agent can resolve work to
people without guessing.

## Four stores, on purpose

- **Second brain** (`notes`): the USER's knowledge. Markdown + vectors, recall
  on demand.
- **Agent self-memory** (`agent-memory`): the AGENT's operational knowledge —
  preferences ("group summaries by project"), corrections/aliases ("'the
  register' = sheet 4821"), tool quirks, self-observations. Written via the
  remember_lesson tool when the user corrects it. The store holds 40. A turn
  receives at most 8, chosen by overlap with the request, and a match records
  a use so unused lessons can be consolidated. A lesson never overrides a
  skill, an approval, or the current request.
- **Org directory** (`org`): teams, people, reporting, and mandates. Admins
  edit it on `/admin/org`. Commitments remain follow-through from meetings.
- **Execution graph** (`graph-nodes` + `graph-edges`): shared projects, tasks,
  ownership, dependencies, and projected source context. Inferred edges wait
  for human review; personal notes stay out unless explicitly promoted.

## Agent topology: profiles now, multi-agent later

`config/agents.json` defines agents as data: persona + tool allowlist + model
route. `capture` (default), `pmo` (Smartsheet specialist), `digest`
(scheduled synthesis) ship today, all served by one agent loop in one process.
The seam is deliberate: if scale ever justifies true multi-agent (parallel
specialists, queue-based handoff), each profile lifts out to its own worker
unchanged — the definition format, tool registry, and activity log already
speak per-agent. Don't pay the coordination tax before the workload demands it.

## Production hardening (built in)

- **Risk-tiered approvals.** Read-only work and clear reversible personal
  captures can proceed immediately. Shared, destructive, scheduled, costly, or
  broad operations—native or MCP—park as an immutable action preview (1h);
  Teams renders Approve/Deny actions and text channels accept
  `approve <id>` / `deny <id>`.
  New deployments begin in measured shadow mode; repository variables stage
  policy and clarification enforcement after mismatch review.
- **Alerts.** Conversation references are stored per user, so the system can
  proactively message anyone: job owners get failure alerts, and
  ADMIN_AAD_OBJECT_ID gets admin alerts (budget trips, exhausted retries).
- **Budget guard.** DAILY_TOKEN_BUDGET caps the day's tokens; past it, all
  non-triage calls downgrade to the cheap tier until midnight UTC, with a
  one-time admin alert. Counter is rebuilt from the activity log every 5 min,
  so restarts/scale-out don't reset it. A single run also stops past
  `RUN_COST_CEILING_USD` (default $2), using the list prices in
  `src/services/modelCost.ts`.
- **Run control.** Each queued request has a deadline (default 4 minutes).
  The deadline aborts the in-flight model call. Up to 8 tool rounds. Read-only
  tools in one response run together; writes stay sequential. Native tool
  arguments are checked against the tool schema before the handler runs. The
  tool transcript is checkpointed so a retry of the same intent resumes.
  The worker, delivery pump, and orchestrator each take up to 3 items at a
  time, but never two for the same person.
- **Job claiming + retries.** Due jobs are claimed with etag-conditioned
  writes (scale-out safe, no double runs). Failures retry twice at 5-minute
  intervals, then alert owner + admin; recurring jobs skip to the next slot,
  one-offs disable. The orchestrator still polls every 60s and runs up to
  3 due jobs per tick.
- **App Insights** provisioned and wired via connection string for
  infra-level telemetry alongside the app-level activity log.
- **Tests + supply chain.** node:test suite runs in CI before deploy;
  Dependabot keeps npm and Actions dependencies patched weekly.
- **Self-healing.** Accepted work ends delivered, explicitly failed, or
  quarantined with a request id. Transient dependencies retry with jitter;
  deadlines and ambiguous tool writes do not run again automatically.
  `/admin/recovery` and `/admin/models` expose incidents and Foundry model
  portfolio recommendations. Model and prompt changes are versioned,
  evaluated, and human-approved before promotion.

