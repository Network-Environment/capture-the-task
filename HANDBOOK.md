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
acts: tasks go to Microsoft To Do, ideas and references become markdown notes
in an Obsidian-compatible "second brain," questions are answered by vector
recall over that brain, and action requests (Smartsheet/PMO operations,
scheduled jobs) run through an agentic tool loop. Confirmation comes back as
an Adaptive Card. Scheduled jobs deliver results proactively.

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
  P -->|approve/deny| APR[approvals]
  P -->|audio| SP[Azure AI Speech]
  P --> TR[triage · CHEAP tier]
  TR -->|task| TODO[Microsoft To Do via Graph]
  TR -->|idea/ref| BR[(Second brain · Blob md + Cosmos vectors)]
  TR -->|question| BR
  TR -->|action| AG[agent loop · profile + tools]
  AG --> REG[tool registry]
  REG --> NAT[native: brain · scheduler · lessons]
  REG --> MCP[MCP servers · Smartsheet …]
  MCP -->|write tools| APR
  AG --> MEM[(agent-memory)]
  SCH[orchestrator · 60s poll] --> AG
  SCH --> DLV[channels/deliver.ts]
  DLV --> T
  DLV --> IM
  R[router · budget · token log] -.every LLM call.-> AG
  R -.-> TR
  ACT[(activity log)] --> ADM[/admin dashboard]
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
  │                 SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET]
  │     infra/main.bicep
  │       ├─ creates every resource + 3 Foundry models + Basic ACR
  │       ├─ Easy Auth on the web app (TaskBrain Admin Entra app;
  │       │  /api/messages and /healthz excluded)
  │       ├─ gives the App Service system identity AcrPull on ACR
  │       └─ WRITES ALL APP SETTINGS: keys via listKeys() (Cosmos, Storage,
  │          Speech, Foundry), endpoints, deployment names, and the secrets
  │          above → the code's process.env is fully populated
  ├─ az acr build → taskbrain:<git-sha> (build happens inside Azure)
  ├─ App Service pulls the immutable image through managed identity
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
   one capture → {task | idea | reference | question | action | followup}
        │
        ├── task       → Graph → Microsoft To Do (fallback: brain) + note
        ├── idea/ref   → brain.ts: markdown → Blob, metadata+vector → Cosmos
        ├── question   → brain.ts::recall (vector) → synthesis tier answer
        ├── action     → AGENT LOOP (see below) — or, on capture-only
        │                channels (iMessage default), saved + deferred to Teams
        └── followup   → resolvedText re-triaged once (5-turn/15-min window)
        ▼
Outbound {title, body, tags} → adapter renders (Adaptive Card / plain text)

AGENT LOOP — agent.ts::runAgent
   profile (config/agents.json): persona + tool allowlist + model route
   + lessons from agent self-memory injected into system prompt
   tools = native (save_note, recall_notes, schedule_job, list_jobs,
           cancel_job, remember_lesson) + MCP tools (config-driven discovery)
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
| `src/index.ts` | restify server, adapter, alert init, orchestrator start, `/admin`, `/healthz` |
| `src/pipeline.ts` | **channel-agnostic capture pipeline**: approvals, transcription, triage, execute → Outbound |
| `src/bot.ts` | Teams adapter: activity → CaptureInput, Adaptive Card rendering, Graph task hook |
| `src/channels/photon.ts` | iMessage adapter via Photon spectrum-ts: stream consumer, allowlist, voice memo fetch, proactive send |
| `src/channels/deliver.ts` | proactive delivery router (Teams or iMessage by last-used channel) |
| `src/channels/types.ts` | channel policy, identity resolution, plain-text rendering |
| `src/services/agent.ts` | triage (cheap tier + escalation), agent loop (profiles), question synthesis |
| `src/services/router.ts` | task-class → deployment mapping, escalation, **daily token budget guard**, per-call usage logging |
| `src/services/brain.ts` | user's second brain: markdown → Blob, metadata+embedding → Cosmos, vector recall |
| `src/services/agentMemory.ts` | agent's own lessons: store, prompt injection, cap-40 consolidation |
| `src/services/scheduler.ts` | job CRUD, cron next-run (cron-parser, `JOBS_TIMEZONE`), due-job query |
| `src/jobs/orchestrator.ts` | 60s poller, etag claiming, retries, proactive delivery |
| `src/services/transcription.ts` | Azure AI Speech fast transcription REST |
| `src/services/graphTasks.ts` | Microsoft To Do via Graph (Bot Service OAuth connection) |
| `src/services/session.ts` | 5-turn follow-up buffer (Cosmos TTL 900s) |
| `src/services/approvals.ts` | write-tool parking, `approve/deny <id>` handling |
| `src/services/conversations.ts` | per-user, per-channel references (`{user}:teams`, `{user}:imessage`, `{user}:latest`) |
| `src/services/alerts.ts` | proactive alerts to users and admin |
| `src/services/activityLog.ts` | event spine: captures, triage, tool/model calls (+tokens), job runs, errors |
| `src/admin/dashboard.ts` | server-rendered `/admin` page |
| `src/tools/registry.ts` | unified tool definitions + dispatch (native + MCP + approval gate) |
| `src/tools/mcpClient.ts` | MCP Streamable HTTP client, config-driven discovery, namespacing |
| `config/channels.json` | iMessage policy: enabled, allowActions, phone→userId identity map (= allowlist) |
| `config/mcp.servers.json` | external integrations: url, token env, allowTools, confirmTools |
| `config/agents.json` | agent profiles (persona, tools glob, route) |
| `config/model.routes.json` | task classes → deployment env vars, escalation rule |
| `infra/main.bicep` | all Azure resources |
| `Dockerfile` | multi-stage production image (Node 22, non-root runtime) |
| `scripts/bootstrap.sh` | one-time Entra/M365 setup (idempotent) |
| `.github/workflows/deploy.yml` | CI/CD via OIDC |
| `teams-app/manifest.json` | Teams app package (needs color.png 192², outline.png 32²) |

### Data model (Cosmos DB `taskbrain`, serverless)

| Container | PK | TTL | Contents |
|---|---|---|---|
| `notes` | `/userId` | — | note metadata + 1536-dim embedding (diskANN, cosine). Canonical note body also lives as markdown in Blob `notes/{userId}/{yyyy-mm}/{id}.md` |
| `sessions` | `/userId` | 900s | rolling 5-turn follow-up buffer |
| `jobs` | `/userId` | — | scheduled jobs: cron/runOnce, prompt, nextRun, conversationRef, retryCount, last* |
| `activity` | `/day` | 30d | event stream incl. model calls with token counts |
| `agent-memory` | `/userId` | — | agent lessons (≤40/user, auto-consolidated) |
| `conversations` | `/userId` | — | per-channel references: Teams conversationRef or iMessage phone/space; `:latest` pointer |
| `pending` | `/userId` | 3600s | parked write actions awaiting approve/deny |

### The two memories (do not merge them)

The **second brain** (`notes` + Blob) is the user's knowledge — retrieved on
demand, never injected wholesale. **Agent self-memory** (`agent-memory`) is
the agent's operational knowledge (preferences, aliases, tool quirks,
self-observations) — injected into every agent prompt, hard-capped and
consolidated so it cannot become context rot. New features that "remember"
something must pick the correct store by asking: is this the user's knowledge,
or the agent's knowledge about how to operate?

### Channels (Teams + iMessage)

Teams is the system of record and the only channel with Graph auth (To Do)
and full actions. iMessage runs through **Photon** (`spectrum-ts`): a single
persistent gRPC stream in the App Service process handles inbound messages,
replies, and voice-memo bytes. Photon has no HTTP send endpoint, so the SDK
stream is the only viable two-way mode; no webhook or public URL is involved.

Identity: iMessage senders are E.164 phone numbers; the brain is keyed by
Entra object id. `config/channels.json` `identities` maps phone → userId and
doubles as the allowlist — unknown numbers are ignored silently (no reply, no
brain). DMs only; group chats are ignored. Inbound is deduped on `message.id`.

Governance: `allowActions` (default `false`) makes iMessage capture-only —
tasks, ideas, questions work; tool actions are saved as `pending-action`
references and deferred to Teams. Flip it deliberately after deciding what
work data may flow through the iMessage bridge. Approvals (`approve pa-x`)
work on either channel as plain text.

### Context-rot policy (why the bot stays fast forever)

The model never sees the Teams thread. Per call it sees: system prompt (+
lessons for agent calls) + at most 5 recent turns (15-min TTL) + the single
new message + explicitly retrieved notes. Memory lives in stores, not chat.
Any change that starts feeding conversation history into prompts violates the
core design.

## 3. Configuration surfaces

Three config files change behavior without code:

- **`config/mcp.servers.json`** — integrations. Per server: `url`, `authEnv`
  (env var holding the bearer token), `allowTools` (allowlist; omit = all),
  `confirmTools` (writes that park for human approval), `enabled`.
- **`config/agents.json`** — profiles. Per profile: `persona` (system
  prompt), `tools` (`"*"`, exact names, or `server__*` globs), `route` (task
  class). `default` names the fallback profile.
- **`config/channels.json`** — iMessage `enabled`, `allowActions`, and the
  `identities` phone→userId map (which is also the allowlist).
- **`config/model.routes.json`** — task classes → env-var-named deployments
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
| `STORAGE_CONNECTION_STRING` / `NOTES_CONTAINER` | Blob notes | Bicep + `listKeys()` |
| `COSMOS_ENDPOINT` / `COSMOS_KEY` / `COSMOS_DB` | Cosmos DB | Bicep + `listKeys()` |
| `GRAPH_CONNECTION_NAME` | Bot Service OAuth connection name | Bicep constant `graph-connection` |
| `SMARTSHEET_API_TOKEN` | bearer for mcp.smartsheet.com | GitHub secret (optional) |
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
3. **Push to `main`.** Pipeline: build → tests → OIDC login → Bicep (all
   resources, ACR, three model deployments, every app setting, Bot OAuth) →
   build an immutable image in ACR → App Service restart → health check.
   No zip artifact or Kudu/OneDeploy extraction is involved.
4. **Teams package:** add `color.png` (192×192) and `outline.png` (32×32)
   beside the patched manifest; zip the three at the root; Teams admin center →
   Manage apps → Upload new app; scope via app permission policy if desired.
5. **iMessage via Photon (optional):** create a project at app.photon.codes,
   provision a line, add `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` as
   GitHub secrets (`gh secret set …`), fill `config/channels.json` identities
   (E.164 phone → Entra object id: `az ad user show --id user@domain --query
   id`), push. Logs show `[imessage] Photon stream connected`.
6. **Smartsheet (optional):** add `SMARTSHEET_API_TOKEN` as a GitHub secret
   and push. Tools appear as `smartsheet__*`.
7. **Verify:** "hello" → welcome; a text task → To Do (or brain fallback); a
   voice memo → transcribed capture; "what did I capture today?" → recall;
   "every Friday at 4 summarize open Smartsheet risks" → job scheduled;
   `/admin` (Entra sign-in) shows all of it.

Ordering constraint: bootstrap must run before the first pipeline
(federated credential, RBAC, RG, providers, secrets). Everything else is
order-independent and re-runnable.

## 5. Operations

- **Dashboard:** `https://<app>.azurewebsites.net/admin` — Entra login; only
  users assigned to the **TaskBrain Admin** enterprise app. Today's counts,
  token spend **per model** (routing efficacy), jobs with last results, agent
  lessons, event stream. Auto-refreshes 60s. Add viewers in Entra → Enterprise
  applications → TaskBrain Admin → Users and groups. `/api/messages` and
  `/healthz` stay anonymous so the bot and CI smoke test keep working.
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
  levers.

## 6. Iteration recipes

**Add an external integration:** add an entry to `config/mcp.servers.json`
(url, `authEnv`, tight `allowTools`, writes in `confirmTools`), set the token
app setting, deploy. Tools appear namespaced `server__tool`. Optionally give
a specialist profile access via a `server__*` glob in `config/agents.json`.

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

1. Chat history never enters prompts beyond the 5-turn/15-min session buffer.
2. Every LLM call goes through `router.route()` — no direct client calls —
   so budget, routing, and token logging stay complete.
3. MCP write tools listed in `confirmTools` are never executed without an
   explicit `approve` from the user.
4. Notes remain plain markdown in Blob with frontmatter + wikilinks.
5. User knowledge → `notes`; agent operational knowledge → `agent-memory`;
   never cross-filed. Lessons stay capped.
6. The orchestrator is the only scheduler; jobs are data; claims are
   etag-conditioned.
7. Logging and alerting are non-fatal: their failures never break the
   capture pipeline.
8. No secrets in the repo. CI authenticates via OIDC only.
9. A capture is never silently lost: every path ends in a saved artifact or
   an explicit error message to the user.
10. All channels feed `processCapture()`; adapters only normalize and render.
    No capture logic lives in an adapter.
11. Non-Teams senders must resolve to a canonical userId through
    `config/channels.json` before anything runs. Never auto-provision a brain
    for an unknown identity.
12. Channel capabilities are policy (`allowActions`), not accident: a new
    channel defaults to capture-only.
13. Config is read only through `src/config.ts::loadConfig` (never imported
    as a module — it lives outside `rootDir`). Every `process.env` read in
    `src/` has a matching app setting written by `infra/main.bicep`.

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
  summarize this week's captures and open Smartsheet risks").

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
  captures still work while tools are absent.
- **Jobs not firing:** orchestrator logs each run; check `jobs` docs'
  `nextRun`/`enabled`; remember one-offs self-disable and claims push
  `nextRun` forward ~10 min while running.
- **iMessage silent:** check `[imessage]` log lines — disabled if
  `SPECTRUM_PROJECT_ID` is empty or `enabled:false`; "ignoring unknown
  sender" means the number isn't in `identities` (E.164 format, with `+`);
  verify SDK method names against the installed `spectrum-ts` version.
- **Budget seems stuck cheap:** it resets at midnight UTC; check `/admin`
  token totals vs `DAILY_TOKEN_BUDGET`.
- **Dashboard login AADSTS50105:** the user is not assigned to **TaskBrain
  Admin**. Entra → Enterprise applications → Users and groups → Add.
- **Dashboard sign-in returns an HTTP error after authenticating:** the
  registration must issue ID tokens — Easy Auth uses
  `response_type=code+id_token`. Entra → App registrations → TaskBrain Admin →
  Authentication → Implicit grant → check **ID tokens**.
- **`/admin` returns 401 from curl:** expected. Easy Auth only redirects
  requests that look like browsers; non-browser clients get a bare 401.
