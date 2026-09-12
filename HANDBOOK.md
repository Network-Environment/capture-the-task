# TaskBrain Handbook

The authoritative reference for building, deploying, operating, and extending
TaskBrain. Written for humans and coding agents alike: if you are an agent
working on this repo, read this file fully before changing anything, and keep
the **Invariants** section true in every change you make.

---

## 1. What this system is

TaskBrain is a personal/team capture assistant for a Microsoft 365
organization (Tristan Energy). A user sends a text message or **voice memo to
a Teams bot** (desktop or mobile). The system transcribes, classifies, and
acts: personal tasks go to Microsoft To Do, ideas and references become markdown notes
in an Obsidian-compatible "second brain," questions are answered by vector
recall over that brain, and action requests (Smartsheet/PMO operations,
scheduled jobs) run through an agentic tool loop. Confirmation comes back as
an Adaptive Card. Shared projects and tasks live in TaskBrain's execution
graph, where the agent and team use the same ownership, dependency, status,
meeting, and evidence relationships. Scheduled jobs deliver results proactively.

Primary external integration: **Smartsheet** (the org's PMO tool) via its
hosted MCP server. The integration layer is generic MCP — more services are
config entries, not code.

## 2. Architecture

```mermaid
flowchart TD
  subgraph Channels
    T[Teams · Bot Framework] --> BOT[src/bot.ts]
    IM[iMessage · Photon spectrum-ts stream] --> PH[src/channels/photon.ts]
  end
  BOT --> P[src/pipeline.ts · processCapture]
  PH --> P
  P --> DEDUP[(inbound receipts)]
  P -->|approve/deny| APR[approvals]
  P -->|audio| SP[Azure AI Speech]
  P --> INT[intent interpreter · CHEAP tier]
  INT -->|ambiguous| CLAR[focused clarification]
  INT --> POL[deterministic risk policy]
  POL -->|personal capture| TODO[Microsoft To Do via Graph]
  POL -->|personal note| BR[(Second brain · Blob md + Cosmos vectors)]
  POL -->|read/action| AG[agent loop · profile + tools]
  POL -->|high impact| APR
  AG --> REG[tool registry]
  REG --> NAT[native: brain · scheduler · web_search]
  REG --> MCP[MCP servers · Smartsheet · browser]
  REG -->|shared/destructive/scheduled| APR
  MCP -->|navigate/snapshot| CAPP[Container App Chromium]
  AG --> MEM[(agent-memory)]
  SCH[orchestrator · 60s poll] --> AG
  SCH --> DLV[channels/deliver.ts]
  DLV --> T
  DLV --> IM
  R[router · budget · token log] -.every LLM call.-> AG
  R -.-> INT
  ACT[(activity log)] --> ADM[/admin dashboard]
  FN[Timer Function · meeting ingest] --> G[Graph transcripts]
  G --> SUM[Foundry structured summary]
  SUM --> MTG[(meetings + commitments)]
  MTG --> ADM
  MTG --> AG
  MTG --> KG[(execution graph · nodes + edges)]
  REG --> KG
  KG --> ADM
  KG --> AG
```

### How everything is linked on deploy (the wiring map)

```
scripts/bootstrap.sh (once, out of band)
  ├─ creates bot app reg + secret, CI app + OIDC federation, resource group
  ├─ patches teams-app/manifest.json + .env
  └─ emits / sets GitHub secrets ──────────────────────────────┐
                                                                ▼
.github/workflows/deploy.yml (on push to main)
  ├─ build → test
  ├─ az login via OIDC (AZURE_CLIENT_ID / TENANT / SUBSCRIPTION)
  ├─ Bicep deploy ← secrets: BOT_APP_ID, BOT_APP_PASSWORD, ADMIN_APP_ID,
  │                 ADMIN_APP_SECRET, ADMIN_AAD_OBJECT_ID, [SMARTSHEET_API_TOKEN,
  │                 SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, WEB_SEARCH_API_KEY]
  │     infra/main.bicep
  │       ├─ creates every resource + 3 Foundry models + Basic ACR
  │       ├─ Container Apps env + always-warm Playwright MCP (browser)
  │       ├─ Easy Auth on the web app (TaskBrain Admin Entra app;
  │       │  /api/messages and /healthz excluded)
  │       ├─ gives the App Service system identity AcrPull on ACR
  │       └─ WRITES ALL APP SETTINGS: keys via listKeys() (Cosmos, Storage,
  │          Speech, Foundry), endpoints, deployment names, and the secrets
  │          above → the code's process.env is fully populated
  ├─ az acr build → taskbrain-browser:<git-sha> BEFORE the Bicep deploy
  │  (Container Apps refuses a revision whose tag is missing from the registry)
  ├─ az acr build → taskbrain:<git-sha>
  ├─ App Service pulls the immutable image through managed identity
  ├─ zip-deploy Flex Consumption Function (meeting ingest timer)
  └─ smoke test /healthz (retries)
                                                                ▼
runtime: src/config.ts loads /config/*.json from the container image;
         every process.env read in src/ has a Bicep-written setting.

Manual after first deploy: Teams app package upload and Photon project setup.
The Bot Service Graph OAuth connection is deployed by Bicep.
```

```
CHANNELS (adapters normalize → src/pipeline.ts)
  Teams  ─ Bot Framework activity ─► Azure Bot Service ─► App Service (src/bot.ts)
  iMessage ─ Photon spectrum-ts persistent gRPC stream (src/channels/photon.ts)
             allowlist + identity map (config/channels.json) → canonical userId
        ▼
PIPELINE — processCapture()  (channel-agnostic)
        │
        ├── approval command? ("approve pa-x" / "deny pa-x")
        │        └─► approvals.ts executes/discards the parked write. STOP.
        ├── audio bytes ──► Azure AI Speech fast transcription
        ▼
TRIAGE  (cheap model tier)  — agent.ts::triage
   one message → {conversation | task | idea | reference | question | action | followup}
        │
        ├── conversation → natural response; nothing persisted or executed
        ├── task       → Graph → Microsoft To Do (fallback: brain) + note
        ├── idea/ref   → brain.ts: markdown → Blob, metadata+vector → Cosmos
        ├── question   → brain.ts::recall (vector) → synthesis tier answer
        ├── action     → AGENT LOOP; PMO/Smartsheet wording uses the pmo profile
        │                (live MCP reads). Writes park for approve pa-x.
        └── followup   → resolvedText re-triaged once (5-turn/15-min window)
        ▼
Outbound {title, body, tags} → adapter renders (Adaptive Card / plain text)

AGENT LOOP — agent.ts::runAgent
   profile (config/agents.json): persona + tool allowlist + model route
   + lessons from agent self-memory injected into system prompt
   tools = native (brain, scheduler, meetings/org, execution graph,
           web_search) + MCP tools (config-driven discovery)
   ≤8 tool rounds; write-listed MCP tools PARK for human approval instead
   of executing.

SCHEDULER — jobs-as-data
   schedule_job tool → Cosmos `jobs` doc (cron or one-off, prompt,
   conversationRef) → orchestrator.ts polls every 60s → etag-claims each due
   job → runs prompt through agent (digest profile) → proactive Teams message
   → advances cron / disables one-off. Failures: 2 retries @5min → alert
   owner + admin → recurring skips to next slot.
```

### Component map

| Path | Responsibility |
|---|---|
| `src/index.ts` | restify server, adapter, alert init, orchestrator start, `/admin` + `/admin/:section`, POST meetings/org, `/healthz` |
| `src/pipeline.ts` | **channel-agnostic intent gateway**: dedup, transcription, context, interpretation, policy, execute → Outbound |
| `src/bot.ts` | Teams adapter: 1:1 and @mentions in team/group chat; Adaptive Card; Graph task hook |
| `src/channels/teamsText.ts` | strip bot @mention markup; personal vs channel conversation |
| `src/channels/photon.ts` | iMessage adapter via Photon spectrum-ts: stream consumer, allowlist, voice memo fetch, proactive send |
| `src/channels/deliver.ts` | proactive delivery router (Teams or iMessage by last-used channel) |
| `src/channels/types.ts` | channel policy, identity resolution, plain-text rendering |
| `src/services/agent.ts` | structured intent interpretation (cheap tier + escalation), agent loop (profiles), question synthesis |
| `src/services/intent.ts` | intent contracts, validation, ambiguity threshold, and deterministic operation policy |
| `src/services/router.ts` | task-class → deployment mapping, escalation, **daily token budget guard**, per-call usage logging |
| `src/services/brain.ts` | user's second brain: markdown → Blob, metadata+embedding → Cosmos, vector recall |
| `src/services/agentMemory.ts` | agent's own lessons: store, prompt injection, cap-40 consolidation |
| `src/services/scheduler.ts` | job CRUD, cron next-run (cron-parser, `JOBS_TIMEZONE`), due-job query |
| `src/jobs/orchestrator.ts` | 60s poller, etag claiming, retries, proactive delivery |
| `src/services/transcription.ts` | Azure AI Speech fast transcription REST |
| `src/services/graphTasks.ts` | Microsoft To Do via Graph (Bot Service OAuth connection) |
| `src/services/session.ts` | conversation-scoped structured turns and pending clarification state |
| `src/services/inboundReceipts.ts` | durable Teams/iMessage event idempotency |
| `src/services/approvals.ts` | immutable high-impact action previews, audited states, `approve/deny <id>` |
| `src/services/conversations.ts` | per-user, per-channel references (`{user}:teams`, `{user}:imessage`, `{user}:latest`) |
| `src/services/alerts.ts` | proactive alerts to users and admin |
| `src/services/activityLog.ts` | event spine: captures, triage, tool/model calls (+tokens), job runs, errors |
| `src/admin/dashboard.ts` | sectioned `/admin` portal + authenticated execution graph JSON API |
| `src/admin/markup.ts` | admin HTML shell, sidebar, shared CSS |
| `src/admin/client/graph.ts` | bundled Cytoscape execution map, filters, editor, and proposal review |
| `src/graph/` | graph types, validation, Cosmos repository/traversal, source projection |
| `src/org/types.ts` | org directory documents: unit, person, role |
| `src/org/resolve.ts` | name/alias resolution, search, capped prompt snapshot |
| `src/org/store.ts` | Cosmos org CRUD + `lookup_org` |
| `src/tools/registry.ts` | unified tool definitions + dispatch (native + MCP + approval gate) |
| `src/services/smartsheet.ts` | PMO catalog prompt, PMO routing, inferred sheet match, write-approval copy |
| `src/meetings/` | Teams meeting ingest worker: Graph delta, VTT parse, Foundry summary, Cosmos/Blob, Adam/Val recall |
| `config/channels.json` | iMessage policy: enabled, allowActions, phone→userId identity map (= allowlist) |
| `config/mcp.servers.json` | external integrations: url, token env, allowTools, confirmTools |
| `config/agents.json` | agent profiles (persona, tools glob, route) |
| `config/model.routes.json` | task classes → deployment env vars, escalation rule |
| `infra/main.bicep` | all Azure resources |
| `Dockerfile` | multi-stage production image (Node 22, non-root runtime) |
| `scripts/bootstrap.sh` | one-time Entra/M365 setup (idempotent) |
| `scripts/backfill-graph.ts` | dry-run-by-default shared-source graph migration |
| `.github/workflows/deploy.yml` | CI/CD via OIDC |
| `teams-app/manifest.json` | Teams app package (needs color.png 192², outline.png 32²) |

### Data model (Cosmos DB `taskbrain`, serverless)

| Container | PK | TTL | Contents |
|---|---|---|---|
| `notes` | `/userId` | — | note metadata + 1536-dim embedding (diskANN, cosine). Canonical note body also lives as markdown in Blob `notes/{userId}/{yyyy-mm}/{id}.md` |
| `sessions` | `/userId` | 900s | conversation-scoped structured turns plus pending clarification |
| `inbound-receipts` | `/channel` | 2d | hashed source event receipts preventing duplicate execution |
| `jobs` | `/userId` | — | scheduled jobs plus immutable read-only tool envelope |
| `activity` | `/day` | 30d | event stream incl. model calls with token counts |
| `agent-memory` | `/userId` | — | agent lessons (≤40/user, auto-consolidated) |
| `conversations` | `/userId` | — | per-channel references: Teams conversationRef or iMessage phone/space; `:latest` pointer |
| `pending` | `/userId` | 1h pending / 7d terminal | parked high-impact action plans and audit state |
| `meetings` | `/organizerId` | 90d | one compact summary + one 1536-dim embedding per meeting. No raw VTT. |
| `commitments` | `/ownerKey` | 180d (14d after done) | tiny follow-through records (no embeddings) |
| `meeting-checkpoints` | `/organizerId` | — | Graph deltaLink per organizer + ingest health (`latest` / `_system`) |
| `org` | `/kind` | — | org directory: teams (`unit`), people, named roles. Mandates only; no transcript or Smartsheet copies. |
| `graph-nodes` | `/workspaceId` | source-derived only | shared projects/tasks plus projected people, meetings, and evidence; 1536-dim embedding for hybrid recall |
| `graph-edges` | `/workspaceId` | source-derived only | typed relationships and review state (`accepted`, `proposed`, `rejected`) |

Blob `meetings/{yyyy-mm}/{id}.md` holds the same structured summary (Cool tier after 1 day, delete after 90). Teams/Graph remains the system of record for transcripts; the agent does not keep VTT. Open commitments can outlive the meeting TTL because they are small JSON, not vectors.

Org-level lessons are written into `agent-memory` with `userId: "org"`, still capped and consolidated. They are injected into agent prompts only for Adam and Val (`MEETING_VIEWERS`).

### Meeting intelligence (org awareness, not a transcript archive)

The five-minute Flex Consumption Function (`src/meetings/timer.ts`) enumerates
tenant members and polls each organizer's `getAllTranscripts` delta feed. That
automatic phase stores **metadata only** in `transcript-availability`; it does
not download VTT or spend model tokens. The first run after this design ships
does a one-time, metadata-only 30-day backfill per organizer, independent of
the existing delta checkpoint.

An admin selects one or more `available` (or retryable `failed`) transcripts
on `/admin/meetings`. The App Service queues them with a CSRF-protected POST;
the Function claims at most `MEETING_SUMMARIES_PER_RUN` (default 2) with
etag concurrency, downloads `text/vtt` in memory, skips near-silent meetings,
and asks the existing synthesis deployment for structured JSON. That JSON
becomes one Cosmos meeting document, one embedding, markdown in Blob, and
new/updated commitment rows. Raw VTT is never stored. Queue states are
`available → queued → processing → summarized | skipped_short | failed`;
stale processing claims recover after 15 minutes. Later meetings that restate
the same owner + work mark the prior commitment done.

Chat tools `recall_meetings`, `list_commitments`, `complete_commitment`, and `lookup_org` are org-wide but **viewer-gated** to Adam (`bceb24c5-ef85-4301-9ab2-073805d535aa`) and Valerie (`4f323599-0df8-47f7-aa01-46dbb211894c`) unless `MEETING_VIEWERS` is overridden. Other TaskBrain users get a deny string. Personal notes stay user-scoped.

Tenant setup that Bicep cannot do: `./scripts/setup-meeting-ingest.sh` assigns Graph application roles on the Function managed identity. A Teams admin must then grant a tenant-wide application access policy and set `EnableGraphTranscriptAccess` / `EnableAttributedTranscripts` (MicrosoftTeams PowerShell **7.9.0+**, or Teams admin center → Meetings → Meeting settings → Transcript API access). Existing meeting transcription does **not** enable Graph export.

Discovery repeats are deduped by transcript ID. Existing meeting summaries
are recognized and marked summarized without another model call.

### Plaud recordings

Plaud is an optional second discovery source for the same org meeting queue.
It is disabled by default (`PLAUD_INGEST_ENABLED=false`) and does not use
Zapier. The five-minute Function uses Plaud's official third-party OAuth
endpoints (the same endpoints used by `@plaud-ai/cli`) to list recordings.
Only metadata is written to `transcript-availability`. When an admin queues a
Plaud row, the Function fetches its transcript in memory and runs the normal
meeting summary, commitment, and graph pipeline. Audio and raw transcripts
are never stored by TaskBrain; Plaud remains their system of record.

One-time setup per Plaud account:

1. Add an account id and its Entra organizer mapping to
   `config/plaud-accounts.json`.
2. On a trusted machine, install the official CLI and have the account owner
   authorize it: `npm i -g @plaud-ai/cli && plaud login`.
3. Sign in to Azure (`az login`), get the vault URL with
   `az keyvault list -g rg-taskbrain --query "[0].properties.vaultUri" -o tsv`,
   then run
   `npm run plaud:import-token -- <account-id> <vault-url>`.
   This imports `~/.plaud/tokens.json`; it never reads or stores the owner's
   password.
4. Set repository variable `PLAUD_INGEST_ENABLED=true` and deploy.

The Function identity can read and update vault secrets through Azure RBAC,
allowing it to persist a rotated Plaud refresh token. A persistent
authentication failure appears in the admin meeting health panel as
`Plaud re-login required`; repeat steps 2–3. Never commit a token or place one
in `config/plaud-accounts.json`.

### Smartsheet (live PMO, not a second archive)

Smartsheet is the PMO system of record. TaskBrain does **not** copy sheet rows
into Cosmos or Blob. Awareness is on-demand MCP (`smartsheet__search`,
`get_sheet`, `get_sheet_summary`) plus optional aliases in
`config/smartsheet.json` (names/ids in the prompt, never cell data).

PMO / risk-register / sheet questions are `action` and run the **pmo**
profile. "What did I capture about X" stays `question` (personal notes).
Explicit "update/add this row" parks `update_rows` / `add_rows` until
`approve pa-x`. After a captured **task**, a high-confidence match to an
existing row may park `update_rows` only (never inferred `add_rows`). Ambiguous
matches are mentioned, not written. Token: GitHub repo secret
`SMARTSHEET_API_TOKEN` → App Service; if tools are missing, check the app
setting, do not mint a new token or re-run bootstrap.

### The four stores (do not merge them)

The **second brain** (`notes` + Blob) is the user's knowledge — retrieved on
demand, never injected wholesale. **Agent self-memory** (`agent-memory`) is
the agent's operational knowledge (preferences, aliases, tool quirks,
self-observations) — injected into every agent prompt, hard-capped and
consolidated so it cannot become context rot. The **org directory** (`org`)
is the company structure: teams, people, reporting, and mandates (what
someone *should* be doing). Admins maintain it on `/admin/org`. Meeting
commitments remain what people *are* doing. A compact snapshot is injected
only for meeting viewers; everyone else uses `lookup_org` (same viewer
gate). New features that "remember" something must pick the store: user
knowledge, agent operating knowledge, org structure, or shared execution?

The **execution graph** (`graph-nodes` + `graph-edges`) is shared operational
state: projects, tasks, owners, dependencies, source meetings, and evidence.
Graph projects/tasks are authoritative once graph writes are enabled. Org
people, meetings, and commitments remain authoritative in their existing
stores and are projected with deterministic IDs (`org-person:*`, `meeting:*`,
`commitment:*`). A normal personal task capture remains a private note/To Do
item; it is never silently published into the shared graph. Create a shared
graph task explicitly through the agent or Execution graph admin page.

Edges are typed: `part_of`, `assigned_to`, `depends_on`, `originated_from`,
`supports`, and `related_to`. Explicit structural links and source projections
are accepted. Model-inferred links always enter as `proposed` and need review.
Dependency cycles, invalid endpoint type pairs, and self-links are rejected.
Agent traversal is capped at two hops / 100 nodes and combines vector seeds
with explicit neighbors; private nodes cannot be used as hidden traversal
bridges.

### Channels (Teams + iMessage)

Teams is the system of record and the only channel with Graph auth (To Do)
and full actions. The app is a **personal bot and a team/group-chat bot**:
1:1 chat still works; in a channel or group, @mention TaskBrain. Captures
file under the mentioner's Entra id. Channel messages that do not mention
the bot are ignored. Scheduled jobs and alerts still deliver to the **1:1**
conversation (open TaskBrain once so a conversation reference exists) — they
do not post into the team channel.

iMessage runs through **Photon** (`spectrum-ts`): a single
persistent gRPC stream in the App Service process handles inbound messages,
replies, and voice-memo bytes. Photon has no HTTP send endpoint, so the SDK
stream is the only viable two-way mode; no webhook or public URL is involved.

Identity: iMessage senders are E.164 phone numbers; the brain is keyed by
Entra object id. `config/channels.json` `identities` maps phone → userId and
doubles as the allowlist — unknown numbers are ignored silently (no reply, no
brain). DMs only; group chats are ignored. Inbound is deduped on `message.id`.

Recognized iMessage identities currently have `allowActions=true`, so Teams
and iMessage call the same agent and tools. Existing approval gates still
park write operations until an explicit `approve pa-x`; channel parity does
not bypass write approval. Unknown numbers remain silently rejected.

Both interactive adapters immediately send `thinking about response` before
processing. The shared intent interpreter resolves recent references, splits
genuinely separate requests, records explicitness and confidence, and asks one
focused question when a mutation is ambiguous. Invalid output fails closed to
clarification. Clear reversible personal captures proceed; shared, destructive,
scheduled, costly, or broad operations are parked with a preview for approval.
Production starts with `INTENT_SHADOW_MODE=true` and enforcement flags false;
the Usage page exposes shadow mismatches and clarification candidates. Promote
repository variables in order: unified policy, clarification enforcement, then
set shadow false after reviewing real traffic.

### Context-rot policy (why the bot stays fast forever)

The model never sees the whole Teams thread. Per call it sees: system prompt
(+ lessons for agent calls) + at most 5 conversation-scoped structured turns
(15-min TTL) + the new message + explicitly retrieved notes. Stored outcomes
and references make follow-ups useful without unbounded history. Memory lives
in stores, not chat.

## 3. Configuration surfaces

Three config files change behavior without code:

- **`config/mcp.servers.json`** — integrations. Per server: `url` or `urlEnv`
  (live URL from an app setting), `authEnv`
  (env var holding the bearer token), `allowTools` (allowlist; omit = all),
  `confirmTools` (writes that park for human approval), `enabled`.
  Vendor systems of record go here (Smartsheet). The `browser` server is our
  own Playwright MCP on a Container App (navigate + snapshot), held at one
  warm replica so Chromium never cold-starts inside an agent turn.
- **`config/agents.json`** — profiles. Per profile: `persona` (system
  prompt), `tools` (`"*"`, exact names, or `server__*` globs), `route` (task
  class). `default` names the fallback profile.
- **`config/channels.json`** — iMessage `enabled`, `allowActions`, and the
  `identities` phone→userId map (which is also the allowlist).
- **`config/smartsheet.json`** — PMO catalog: alias → optional `sheetId` /
  `workspaceId` + one-line purpose. Injected into agent prompts as names/ids
  only. Empty `sheets` is valid (search by name). Never put the API token here.
  (`CHEAP_DEPLOYMENT`, `STANDARD_DEPLOYMENT`, `PREMIUM_DEPLOYMENT`) with max
  tokens/temperature, plus the triage→agent escalation rule.

### Environment variables

All are written to App Service settings by Bicep on every deploy. "Source"
says where the value originates. For local runs, `.env` (gitignored,
patched by bootstrap.sh) supplies the same names.

| Var | Purpose | Source |
|---|---|---|
| `MicrosoftAppId` / `MicrosoftAppPassword` / `MicrosoftAppTenantId` / `MicrosoftAppType` | bot identity | GitHub secrets `BOT_APP_ID`, `BOT_APP_PASSWORD` (bootstrap) + tenant() |
| `FOUNDRY_ENDPOINT` / `FOUNDRY_API_KEY` | Azure AI Foundry (OpenAI-compatible) | Bicep resource + `listKeys()` |
| `CHEAP_DEPLOYMENT` / `STANDARD_DEPLOYMENT` / `PREMIUM_DEPLOYMENT` / `EMBED_DEPLOYMENT` | model tiers | Bicep deployments `cheap`/`standard`/`embed` (PREMIUM = standard until you add a larger deployment) |
| `SPEECH_REGION` / `SPEECH_KEY` | Azure AI Speech | Bicep + `listKeys()` |
| `STORAGE_CONNECTION_STRING` / `NOTES_CONTAINER` / `MEETINGS_CONTAINER` | Blob notes + meeting summaries | Bicep + `listKeys()` |
| `COSMOS_ENDPOINT` / `COSMOS_KEY` / `COSMOS_DB` | Cosmos DB | Bicep + `listKeys()` |
| `MEETING_VIEWERS` | Entra object ids allowed to query meetings/commitments | Bicep default Adam+Val |
| `EXECUTION_GRAPH_ENABLED` | expose graph projection, recall, API, and admin view | Bicep `true` |
| `EXECUTION_GRAPH_WRITES_ENABLED` | expose human/agent project-task mutations | GitHub repository variable, default `false` |
| `GRAPH_WORKSPACE_ID` | shared Cosmos partition / workspace identity | Bicep `org` |
| `INTENT_GATEWAY_ENABLED` / `INTENT_SHADOW_MODE` | structured interpretation and non-enforcing comparison mode | repo variables; defaults `true` / `true` |
| `CLARIFICATION_ENFORCEMENT_ENABLED` | persist and ask before uncertain mutations | repo variable; staged default `false` |
| `UNIFIED_ACTION_POLICY_ENABLED` | risk-policy gate across native and MCP operations | repo variable; staged default `false` |
| `INTENT_CONFIDENCE_THRESHOLD` | minimum confidence before mutation | Bicep `0.72` |
| `MEETING_TTL_DAYS` / `COMMITMENT_TTL_DAYS` | Cosmos TTL for meeting docs / commitments | Bicep 90 / 180 |
| `MEETING_ORGANIZERS_PER_RUN` | Function round-robin batch size | Function app setting (25) |
| `PLAUD_INGEST_ENABLED` | poll mapped Plaud accounts for meeting metadata | GitHub repository variable, default `false` |
| `PLAUD_KEY_VAULT_URL` / `PLAUD_TOKEN_SECRET_NAME` | OAuth token map read and rotated by the Function | Bicep Key Vault; secret populated by `plaud:import-token` |
| `GRAPH_CONNECTION_NAME` | Bot Service OAuth connection name | Bicep constant `graph-connection` |
| `SMARTSHEET_API_TOKEN` | bearer for mcp.smartsheet.com | GitHub **repo** secret (already set); Bicep copies it to App Service. Do not re-run bootstrap. |
| `WEB_SEARCH_API_KEY` / `WEB_SEARCH_ENGINE` | native `web_search` (Tavily default; Brave or Bing) | GitHub secret (optional) + Bicep `webSearchEngine` default `tavily` |
| `BROWSER_MCP_URL` / `BROWSER_MCP_TOKEN` | Streamable HTTP to the browser Container App | Bicep (FQDN + generated or supplied token) |
| `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` | Photon iMessage; blank disables channel | GitHub secrets (optional) |
| `ADMIN_APP_ID` / `ADMIN_APP_SECRET` | App Service Easy Auth (TaskBrain Admin Entra app) | GitHub secrets (bootstrap / `scripts/setup-admin-sso.sh`) |
| `ADMIN_AAD_OBJECT_ID` | admin alert recipient | GitHub secret (bootstrap = signed-in user) |
| `DAILY_TOKEN_BUDGET` / `JOBS_TIMEZONE` | ops knobs | Bicep params (defaults 5,000,000 / America/Chicago) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | telemetry | Bicep |
| `CONFIG_DIR` | override config folder (tests/local only) | unset in prod |

Model catalog note: Bicep params `cheapModelName/Version`, `standardModel*`,
`embedModel*` default to `gpt-5-mini` / `gpt-5` (2025-08-07) /
`text-embedding-3-small` (1). Verify availability in your region's Foundry
catalog; Claude deployments are created in the Foundry portal today, then
point `STANDARD_DEPLOYMENT`/`PREMIUM_DEPLOYMENT` at them via Bicep param or
app setting.

## 4. Deploy runbook (exact order)

**Prereqs:** az CLI 2.60+, Node 22, `gh` CLI (optional but recommended), an
account with Application Administrator + Owner on the subscription, a GitHub
repo, org permission to upload Teams apps.

1. **Bootstrap (one-time, out of band):**
   `./scripts/bootstrap.sh <org>/<repo> rg-taskbrain eastus`
   Creates the bot app registration (+2-year secret, Graph Tasks.ReadWrite,
   admin consent, OAuth redirect), the CI app with GitHub OIDC federation and
   Contributor + RBAC Administrator on the RG, required resource providers,
   the resource group, and the TaskBrain Admin Entra app (assignment-required
   Easy Auth for `/admin`). Patches
   `teams-app/manifest.json` and `.env`. If `gh` is authenticated it sets all
   required GitHub secrets and creates the `production` environment; otherwise
   it prints them for you to paste. Idempotent; re-runs mint a new bot secret
   (update `BOT_APP_PASSWORD` if so). Already-deployed environments: run
   `./scripts/setup-admin-sso.sh <org>/<repo> rg-taskbrain` instead — that
   creates only the Admin app and does not rotate the bot secret.
2. **Local sanity:** `npm ci && npx tsc --noEmit && npm test`. (Also
   review Bicep model params against your region's Foundry catalog.)
3. **Push to `main`.** Pipeline: build → tests → OIDC login → build
   `taskbrain-browser` in ACR → Bicep (all resources including Flex
   Consumption Function + meeting Cosmos containers, ACR, Container Apps
   Playwright MCP, three model deployments, every app setting, Bot OAuth) →
   build `taskbrain` image → App Service restart → health check → zip-deploy
   the meeting ingest Function. The browser image is built first on purpose:
   Container Apps fails revision provisioning if the tag is not already in the
   registry. Optional: set `WEB_SEARCH_API_KEY` in GitHub secrets so
   `web_search` works. The deployment creates graph containers and enables
   read-only graph projection. Agent/admin graph writes remain hidden unless
   the GitHub repository variable `EXECUTION_GRAPH_WRITES_ENABLED` is exactly
   `true`.
4. **Meeting ingest tenant grant (once, after the Function exists):**
   `./scripts/setup-meeting-ingest.sh rg-taskbrain` then the printed Teams
   PowerShell (application access policy + Graph transcript access). Wait
   ~30 minutes, then confirm `/admin` ingest health after a poll.
5. **Teams package:** add `color.png` (192×192) and `outline.png` (32×32)
   beside the patched manifest; zip the three at the root; Teams admin center →
   Manage apps → Upload new app (bump manifest version on each upload). To
   @mention in a channel: add TaskBrain to that team (Apps → TaskBrain → Add
   to a team). Scope org-wide via app permission policy if desired.
6. **iMessage via Photon (optional):** create a project at app.photon.codes,
   provision a line, add `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` as
   GitHub secrets (`gh secret set …`), fill `config/channels.json` identities
   (E.164 phone → Entra object id: `az ad user show --id user@domain --query
   id`), push. Logs show `[imessage] Photon stream connected`.
7. **Smartsheet:** repo secret `SMARTSHEET_API_TOKEN` is already set; a
   normal deploy copies it to App Service. Fill `config/smartsheet.json`
   aliases when you know sheet ids. Ask a PMO question in chat; writes require
   `approve pa-x`.
8. **Verify:** "hello" → welcome; a text task → To Do (or brain fallback); a
   voice memo → transcribed capture; "what did I capture today?" → recall;
   "every Friday at 4 summarize open Smartsheet risks" → job scheduled;
   on `/admin/meetings`, select one discovered transcript and queue its
   summary; the next Function run moves it through processing → summarized;
   Adam/Val: "what did we decide last week?" / "what's overdue?" uses meeting
   tools; another user is denied.
9. **Execution graph rollout:** leave writes off for the first deploy. Run
   `npm run graph:backfill` with production environment variables to inspect
   shared-source counts and unresolved owners; it does not write by default.
   Apply with `npm run graph:backfill -- --apply`, inspect `/admin/graph` for
   orphan counts and projected commitments, then set the GitHub repository
   variable `EXECUTION_GRAPH_WRITES_ENABLED=true` and redeploy. Roll back
   writes by setting it to `false`; projections and reads continue. Roll back
   the entire feature with Bicep `executionGraphEnabled=false`. The backfill is
   idempotent and never scans or publishes personal notes.

Ordering constraint: bootstrap must run before the first pipeline
(federated credential, RBAC, RG, providers, secrets). Everything else is
order-independent and re-runnable.

## 5. Operations

- **Dashboard:** `https://<app>.azurewebsites.net/admin` — Entra login; only
  users assigned to the **TaskBrain Admin** enterprise app. Sidebar sections:
  **Overview** (today’s KPIs, budget, discovery snapshot), **Capabilities**
  (agent skills + native/MCP tools), **Integrations** (status vs catalog;
  tokens never displayed), **Usage** (models, channels, tools, people,
  events), **Org** (people, teams, named roles), **Meetings** (availability + selected summary queue), **Jobs**,
  **Memory**. Usage separates origin, channel, input mode, and tokens by
  origin; legacy meeting events normalize to internal discovery instead of
  unknown. Auto-refreshes 60s. Add
  viewers in Entra → Enterprise applications → TaskBrain Admin → Users and
  groups. `/api/messages` and `/healthz` stay anonymous so the bot and CI
  smoke test keep working.
- **Execution graph:** `/admin/graph` is an interactive, non-auto-refreshing
  Cytoscape view. Search or filter by type/status/owner, inspect dependencies
  and source evidence, edit TaskBrain-owned projects/tasks, and accept/reject
  proposed links. People, meetings, and commitment projections are read-only;
  edit their source system. The accessible list beneath the canvas provides
  the same selection path without pointer-only graph navigation. Page state
  and viewport stay local to the browser.
- **Alerts (push):** job failures after final retry → owner + admin; budget
  trip → admin, once per day. Delivery requires the recipient to have
  messaged the bot at least once (conversation reference).
- **Budget guard:** past `DAILY_TOKEN_BUDGET`, all non-triage calls run on
  the cheap tier until midnight UTC. Counter rebuilds from the activity log
  every 5 min (restart/scale-out safe).
- **Approvals:** parked writes expire in 1h. Approve/deny by replying
  `approve pa-xxxx` / `deny pa-xxxx` in the same chat.
- **Job admin from chat:** "list my jobs", "cancel <name>" (agent tools).
- **Logs:** App Insights (infra), `activity` container (app events, 30-day
  TTL), App Service log stream for console output.
- **Cost posture at personal scale:** ~$20–60/mo lean (Cosmos vector search)
  — dominated by model tokens; the cheap-tier triage and budget guard are the
  levers. The browser Container App adds a flat ~$20–25/mo: it holds one
  resident replica (1 vCPU / 2 GiB), billed at the East US idle rate of
  $0.000003 per vCPU-second and per GiB-second. Scaling it to zero would save
  that, at the price of a ~45s Chromium cold start inside the agent turn that
  needs it — the trade we deliberately declined.

## 6. Iteration recipes

**Add an external integration:** add an entry to `config/mcp.servers.json`
(url or `urlEnv`, `authEnv`, tight `allowTools`, writes in `confirmTools`), set the token
app setting, deploy. Tools appear namespaced `server__tool`. Optionally give
a specialist profile access via a `server__*` glob in `config/agents.json`.

**Give the agent public-web research:** native `web_search` (query → titles/URLs/snippets;
set GitHub secret `WEB_SEARCH_API_KEY`) plus `browser__navigate` / `browser__snapshot`
on an always-warm Container App. Search first; open a URL only when the user
named it or a hit must be read as a rendered page. Caps: 1 search and 3 browser
calls per turn. SSRF blocks `file:`, localhost, and private IPs. Snapshots are
truncated; page HTML is never written to Cosmos/Blob unless the user asks to
`save_note`. Chromium is not in the App Service image. Click/type/login are
out of v1. `digest` does not get search.

**Use the execution graph:** ask "what is blocked on Project X?", "who owns
the launch tasks?", or "why does this work exist?" so the agent uses
`search_execution_graph` and follows accepted edges. Explicitly ask "create a
shared task/project" to use `create_graph_task` / `create_graph_project`;
ordinary captured tasks stay private. `update_graph_item` changes TaskBrain-
owned records. `propose_graph_relationship` is the only inference path and
cannot self-approve. Keep queries narrow; the two-hop/100-node cap is a
safety and context-budget boundary, not a paging target.

**Add/adjust an agent profile:** edit `config/agents.json`. Persona = system
prompt; keep tool allowlists minimal; pick the route by cost (agent for tool
work, digest only for scheduled synthesis). No code changes.

**Retier models:** change the `*_DEPLOYMENT` app settings (no deploy), or
edit `config/model.routes.json` to add task classes / change limits (deploy).
Check `/admin` token-by-model afterward to confirm the shift.

**Add a native tool:** definition in `src/tools/registry.ts` (`nativeDefs`)
+ a `dispatch` case. Return strings; throw nothing (errors return as text so
the model can recover). Log via `logActivity` if the action matters.

**Add a scheduled behavior:** don't add timers — tell the bot to schedule it,
or insert a `jobs` doc. The orchestrator is the only clock.

**Change note structure:** `brain.ts::renderMarkdown` controls the markdown;
keep YAML frontmatter + `[[wikilinks]]` (Obsidian compatibility is a feature
contract). If embedding dimensions change, update the Bicep vector policy and
re-embed.

**Change a runtime setting or secret:** app settings are owned by Bicep —
edit `infra/main.bicep` params/defaults or the GitHub secret, then push.
Hand-edits in the portal are overwritten on the next deploy by design.

**Change behavior without a rebuild:** `config/*.json` ships in the deploy
zip and is read at boot via `src/config.ts`; edit, commit, push (the deploy
is the restart). `CONFIG_DIR` can point at an alternate folder locally.

**Add a channel:** write an adapter in `src/channels/` that resolves the
sender to a canonical userId, builds a `CaptureInput`, calls
`processCapture`, and renders the `Outbound`. Register proactive delivery in
`channels/deliver.ts` and a channel value in `channels/types.ts`. Default
`allowActions` to false. Start it from `src/index.ts`.

**Go multi-agent (only when needed):** signals — agent runs hitting the
8-round cap regularly, jobs queueing behind slow ones, or profiles needing
separate auth boundaries. Path: lift a profile to its own worker consuming a
Service Bus queue; the profile format, registry, and per-agent activity
logging already support it. Do not pay this tax early.

## 7. Invariants (agents: keep these true)

1. Chat history never enters prompts beyond the 5-turn, conversation-scoped
   structured session buffer; full channel threads are never ingested.
2. Every LLM call goes through `router.route()` — no direct client calls —
   so budget, routing, and token logging stay complete.
3. With unified policy enforcement enabled, shared, destructive, scheduled,
   costly, or broad operations—native or MCP—require a user-visible preview
   and explicit approval. During shadow rollout, existing MCP `confirmTools`
   remain the live minimum. Clear reversible personal captures may execute.
4. Notes remain plain markdown in Blob with frontmatter + wikilinks.
5. User knowledge → `notes`; agent operational knowledge → `agent-memory`;
   never cross-filed. Lessons stay capped.
6. The App Service orchestrator is the only scheduler for chat jobs; jobs
   are data; claims are etag-conditioned. Meeting ingest is a separate
   Functions timer (Graph polling), not a chat job.
7. Logging and alerting are non-fatal: their failures never break the
   capture pipeline.
8. No secrets in the repo. CI authenticates via OIDC only.
9. A capture is never silently lost: every path ends in a saved artifact or
   an explicit error message to the user.
10. All channels feed `processCapture()` with a stable event id, canonical
    identity, conversation scope, and declared capabilities. Adapters only
    authenticate/normalize and render; no intent logic lives in an adapter.
11. Non-Teams senders must resolve to a canonical userId through
    `config/channels.json` before anything runs. Never auto-provision a brain
    for an unknown identity.
12. Channel capabilities are structured policy, not a permissive boolean.
    Group or weak-identity traffic cannot mutate; future channels must declare
    identity assurance, scope, write capabilities, and approval UX.
13. Config is read only through `src/config.ts::loadConfig` (never imported
    as a module — it lives outside `rootDir`). Every `process.env` read in
    `src/` has a matching app setting written by `infra/main.bicep`.
14. Chromium never ships in the App Service image. Public-web research is
    `web_search` plus a remote browser MCP. Crawled page HTML is not stored
    in the brain unless the user explicitly `save_note`s a summary.
15. Personal notes and ordinary task captures are never published to the
    shared execution graph implicitly. Promotion must be explicit.
16. Graph source projections are deterministic and read-only. Update people,
    meetings, or commitments in their source store; only TaskBrain-owned
    projects/tasks are directly editable.
17. Agent-inferred graph relationships remain `proposed` until a human
    accepts them. Accepted dependency edges must remain acyclic.
18. With clarification enforcement enabled, ambiguous or inferred mutations
    always clarify before execution. Tool descriptions and prompts are not
    authorization boundaries.
19. New scheduled jobs run only the read-only tool envelope captured when
    approved; legacy jobs receive and persist the safe envelope on first run.

## 8. Known gaps / roadmap

- Key-based Cosmos/Storage auth → migrate to managed identity + RBAC data
  plane once stable.
- Single Smartsheet service token → per-user OAuth before broad rollout.
- Triage eval harness: after a few weeks of real captures, sample `activity`
  triage events, label, and measure cheap-tier accuracy before trusting it
  further.
- Teams package publishing via Graph API in CI (manifest changes are rare;
  manual upload is fine for now).
- iMessage identity map is static config; a Teams-issued link code flow
  would let users self-enroll phone numbers.
- Weekly digest job: create via chat once deployed ("every Friday at 4pm
  summarize this week's captures, overdue meeting commitments, and open
  Smartsheet risks") as Adam or Val so `list_commitments` is allowed.

## 9. Troubleshooting quick hits

- **Pipeline infra job fails "missing required secrets":** run
  `scripts/bootstrap.sh` (with `gh` logged in) or paste the printed secrets.
- **tsc "not under rootDir":** something imported `../../config/*.json` as a
  module. Use `loadConfig()` from `src/config.ts` instead.
- **Model deployment creation fails:** the model name/version isn't in your
  region's catalog — adjust the `*ModelName/Version` Bicep params.
- **Bot silent in Teams:** check App Service log stream; verify
  `MicrosoftApp*` settings and that the bot endpoint is
  `https://<app>.azurewebsites.net/api/messages`; confirm the Teams channel
  is enabled on the bot resource.
- **Voice memos fail:** attachment download needs the connector token
  (Teams-served URLs); confirm `supportsFiles: true` in the manifest and
  Speech key/region.
- **To Do errors → "saved to brain instead":** OAuth connection name must
  equal `GRAPH_CONNECTION_NAME`; test the connection in the bot resource
  blade; confirm admin consent for Tasks.ReadWrite.
- **No MCP tools:** check `SMARTSHEET_API_TOKEN`; console logs
  `[mcp] failed to connect` per server; the bot degrades gracefully, so
  capture still works. Browser MCP needs `BROWSER_MCP_URL` (Container App up)
  and a successful `az acr build` of `taskbrain-browser`.
- **Web search always "not configured":** set repo secret `WEB_SEARCH_API_KEY`
  (Tavily `tvly-…` Bearer token from [app.tavily.com](https://app.tavily.com/);
  or Brave / Bing if `WEB_SEARCH_ENGINE` is `brave`/`bing`) and redeploy so
  Bicep copies it.
- **CI fails `AuthorizationFailed` on `Microsoft.X/register/action`:** provider
  registration is subscription scope and the CI identity only has rights on
  `rg-taskbrain`. Register once as an owner:
  `az provider register -n Microsoft.App --wait` (same for
  `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`), or re-run
  `scripts/bootstrap.sh`. Do not add provider registration to the pipeline.
- **Container App revision fails `MANIFEST_UNKNOWN`:** Bicep referenced an
  image tag that is not in ACR yet. The pipeline builds `taskbrain-browser`
  before the Bicep step for this reason; if you deploy Bicep by hand, pass
  `browserImage=<acr>.azurecr.io/taskbrain-browser:<tag>` or let it fall back
  to the public placeholder default.
- **Jobs not firing:** orchestrator logs each run; check `jobs` docs'
  `nextRun`/`enabled`; remember one-offs self-disable and claims push
  `nextRun` forward ~10 min while running.
- **iMessage silent:** check `[imessage]` log lines — disabled if
  `SPECTRUM_PROJECT_ID` is empty or `enabled:false`; "ignoring unknown
  sender" means the number isn't in `identities` (E.164 format, with `+`);
  verify SDK method names against the installed `spectrum-ts` version.
- **Budget seems stuck cheap:** it resets at midnight UTC; check `/admin`
  token totals vs `DAILY_TOKEN_BUDGET`. Usage → Tokens by origin identifies
  chat, scheduled, and admin-triggered meeting-summary consumption.
- **Dashboard login AADSTS50105:** the user is not assigned to **TaskBrain
  Admin**. Entra → Enterprise applications → Users and groups → Add.
- **Dashboard sign-in returns an HTTP error after authenticating:** the
  registration must issue ID tokens — Easy Auth uses
  `response_type=code+id_token`. Entra → App registrations → TaskBrain Admin →
  Authentication → Implicit grant → check **ID tokens**.
- **`/admin` returns 401 from curl:** expected. Easy Auth only redirects
  requests that look like browsers; non-browser clients get a bare 401.
- **Transcript discovery Graph 403:** run `scripts/setup-meeting-ingest.sh` and
  the printed Teams PowerShell. `EnableGraphTranscriptAccess` is independent
  of in-meeting transcription. Policy can take ~30 minutes.
- **400 `max_tokens` / `temperature` unsupported:** gpt-5-class deployments
  need `max_completion_tokens` and the default temperature. Deployment names
  (`cheap`, `standard`) don't reveal the model, so `router.ts` learns this
  from the first rejection, retries, and caches it per deployment for the
  process. A cold start re-learns it (one retried call).
- **Function has no functions after deploy:** Flex Consumption needs the zip
  at the `fn-packages` container; CI `config-zip` step must succeed after
  infra created `functionAppName`.
- **Execution graph is empty:** confirm `EXECUTION_GRAPH_ENABLED=true` on both
  App Service and the meeting Function, then dry-run/apply
  `npm run graph:backfill`. Missing embeddings on older projected records are
  repaired by the same idempotent backfill.
- **Execution graph is read-only:** this is the safe rollout default. Set the
  GitHub repository variable `EXECUTION_GRAPH_WRITES_ENABLED=true` and
  redeploy after reviewing the backfill. Do not hand-edit the App Service
  setting; Bicep overwrites it.
- **Graph editor returns 409:** the item changed after the page loaded or the
  dependency would create a cycle. Reload the graph and reapply a valid edit.
- **Graph canvas is blank but the list works:** verify
  `/admin/assets/graph.js` returns JavaScript. `npm run build` creates the
  local bundle; `npm run dev` builds it once before starting the watcher.
