import { esc, renderShell, table } from "./markup";
import type { RecoveryIncident } from "../services/recoveryIncidents";
import { deploymentInventory, recommendModel, type ModelCandidate } from "../services/modelPortfolio";
import { replayAllowed, type QueuedAgentRequest } from "../services/requestQueue";

const SAMPLE_CANDIDATES: ModelCandidate[] = [
  { model: "gpt-4.1-mini", version: "2025-04-14", inputPerMillion: 0.4, outputPerMillion: 1.6, latencyMs: 700, quality: 0.78, toolReliability: 0.74, contextTokens: 128000, retired: false, regionAllowed: true },
  { model: "gpt-5-mini", version: "2025-08-07", inputPerMillion: 0.25, outputPerMillion: 2, latencyMs: 900, quality: 0.86, toolReliability: 0.84, contextTokens: 128000, retired: false, regionAllowed: true },
  { model: "gpt-5", version: "2025-08-07", inputPerMillion: 1.25, outputPerMillion: 10, latencyMs: 1400, quality: 0.93, toolReliability: 0.9, contextTokens: 256000, retired: false, regionAllowed: true },
];

export function renderRecovery(
  signedIn: string,
  incidents: RecoveryIncident[],
  canMutate: boolean,
  csrf = ""
): string {
  const rows = incidents.map((incident) =>
    `<tr><td class="mono">${esc(incident.id)}</td><td>${esc(incident.kind)}</td><td>${esc(incident.summary)}</td><td>${esc(incident.requestId ?? "")}</td><td>${
      canMutate
        ? `<form method="post" action="/admin/recovery"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="scope" value="recovery"><input type="hidden" name="incident" value="${esc(incident.id)}"><input type="hidden" name="source" value="${esc(incident.source)}"><input type="hidden" name="subject" value="${esc(incident.subject)}"><button name="action" value="dismiss">Dismiss</button></form>`
        : "read only"
    }</td></tr>`
  ).join("");
  return renderShell({
    section: "recovery",
    signedIn,
    title: "Recovery",
    subtitle: "Quarantine, replay, and delivery incidents",
    body: `<section class="panel"><h2>Open incidents</h2><p class="pad muted">Replay and promotion stay off unless production admin authentication and the recovery flags are enabled.</p>${table(["Incident", "Kind", "Summary", "Request", "Action"], rows, "No open incidents.")}</section>`,
  });
}

export function recoveryDecision(input: {
  action: string;
  request?: QueuedAgentRequest;
  productionAdmin: boolean;
}): { ok: boolean; reason: string } {
  if (!input.productionAdmin) return { ok: false, reason: "production admin sign-in is required" };
  if (input.action === "dismiss") return { ok: true, reason: "dismiss" };
  if (input.action === "replay") {
    if (!input.request) return { ok: false, reason: "request not found" };
    return replayAllowed(input.request);
  }
  if (input.action === "retry-delivery") return { ok: true, reason: "delivery retry" };
  return { ok: false, reason: "unknown recovery action" };
}

export function renderModels(signedIn: string): string {
  const inventory = deploymentInventory();
  const rows = inventory.map((row) =>
    `<tr><td>${esc(row.tier)}</td><td class="mono">${esc(row.deployment)}</td><td>${esc(row.model)}</td><td>${esc(row.version)}</td><td>${row.independent ? "yes" : "alias of standard"}</td></tr>`
  ).join("");
  const current = SAMPLE_CANDIDATES[1];
  const advice = recommendModel({
    workload: "agent",
    current,
    candidates: SAMPLE_CANDIDATES,
    qualityFloor: 0.8,
  });
  return renderShell({
    section: "models",
    signedIn,
    title: "Models",
    subtitle: "Foundry deployment inventory and portfolio recommendation",
    body:
      `<section class="panel"><h2>Deployed tiers</h2>${table(["Tier", "Deployment", "Model", "Version", "Independent"], rows, "No deployments.")}</section>` +
      `<section class="panel"><h2>Agent workload</h2><p class="pad">Recommendation: <strong>${esc(advice.action)}</strong> ${advice.model ? esc(advice.model) : ""}. ${esc(advice.reason)}</p><p class="pad muted">Catalog refresh is read-only until an administrator approves a separate blue-green deployment. Premium currently shares the standard deployment.</p></section>`,
  });
}
