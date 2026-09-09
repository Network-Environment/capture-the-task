import cytoscape, { type Core, type ElementDefinition } from "cytoscape";

type NodeType = "project" | "task" | "person" | "meeting" | "evidence";
type NodeStatus = "planned" | "active" | "blocked" | "done" | "cancelled" | "open" | "stale";
type ReviewState = "accepted" | "proposed" | "rejected";

interface NodeDoc {
  id: string;
  type: NodeType;
  title: string;
  description?: string;
  status?: NodeStatus;
  ownerPersonId?: string;
  due?: string;
  source?: { kind: string; id: string };
  version: number;
}

interface EdgeDoc {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  reviewState: ReviewState;
  evidence?: string;
  confidence?: number;
  version: number;
}

interface Payload {
  nodes: NodeDoc[];
  edges: EdgeDoc[];
  truncated?: boolean;
  nextCursor?: string;
  stats?: { nodes: number; edges: number; proposals: number; overdue: number; orphans: number };
  matchedIds?: string[];
}

declare global {
  interface Window {
    TASKBRAIN_GRAPH: { csrf: string; scope: string; api: string; writesEnabled: boolean };
  }
}

const config = window.TASKBRAIN_GRAPH;
const graphEl = required<HTMLElement>("execution-graph");
const message = required<HTMLElement>("graph-message");
const detail = required<HTMLElement>("graph-detail");
const list = required<HTMLElement>("graph-list");
const search = required<HTMLInputElement>("graph-search");
const typeFilter = required<HTMLSelectElement>("graph-type");
const statusFilter = required<HTMLSelectElement>("graph-status");
const ownerFilter = required<HTMLInputElement>("graph-owner");
const proposals = required<HTMLInputElement>("graph-proposals");
const dialog = required<HTMLDialogElement>("graph-dialog");
const form = required<HTMLFormElement>("graph-form");

let cy: Core | undefined;
let payload: Payload = { nodes: [], edges: [] };
let selectedId = "";
let debounce: ReturnType<typeof setTimeout> | undefined;

restoreControls();
void load();

for (const control of [typeFilter, statusFilter, ownerFilter, proposals]) {
  control.addEventListener("change", () => void load());
}
search.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 250);
});
required("graph-new-project").addEventListener("click", () => openEditor("project"));
required("graph-new-task").addEventListener("click", () => openEditor("task"));
required("graph-dialog-cancel").addEventListener("click", () => dialog.close());
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveForm();
});
window.addEventListener("beforeunload", persistViewport);

async function load(cursor?: string): Promise<void> {
  saveControls();
  message.textContent = cursor ? "Loading more items…" : "Loading execution graph…";
  try {
    const params = new URLSearchParams({ limit: "50", proposed: String(proposals.checked) });
    if (search.value.trim()) params.set("q", search.value.trim());
    if (typeFilter.value) params.set("types", typeFilter.value);
    if (statusFilter.value) params.set("statuses", statusFilter.value);
    if (ownerFilter.value.trim()) params.set("owner", ownerFilter.value.trim());
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${config.api}?${params}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const result = (await response.json()) as Payload & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Graph request failed (${response.status})`);
    payload = cursor ? mergePayload(payload, result) : result;
    render();
  } catch (err) {
    message.textContent = (err as Error).message;
    message.classList.add("graph-error");
  }
}

function render(): void {
  const prior = cy ? { pan: cy.pan(), zoom: cy.zoom() } : restoredViewport();
  cy?.destroy();
  const elements: ElementDefinition[] = [
    ...payload.nodes.map((node) => ({
      group: "nodes" as const,
      data: {
        id: node.id,
        label: node.title,
        type: node.type,
        status: node.status ?? "",
      },
    })),
    ...payload.edges.filter(
      (edge) =>
        payload.nodes.some((node) => node.id === edge.fromId) &&
        payload.nodes.some((node) => node.id === edge.toId)
    ).map((edge) => ({
      group: "edges" as const,
      data: {
        id: edge.id,
        source: edge.fromId,
        target: edge.toId,
        label: edge.type.replaceAll("_", " "),
        reviewState: edge.reviewState,
      },
    })),
  ];
  const css = getComputedStyle(document.documentElement);
  cy = cytoscape({
    container: graphEl,
    elements,
    minZoom: 0.2,
    maxZoom: 2.5,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "ellipsis",
          "text-max-width": "130px",
          "font-size": 11,
          color: css.getPropertyValue("--text").trim(),
          "background-color": css.getPropertyValue("--accent").trim(),
          "border-width": 2,
          "border-color": css.getPropertyValue("--surface").trim(),
          width: 42,
          height: 42,
        },
      },
      { selector: 'node[type = "project"]', style: { shape: "round-rectangle", width: 62, height: 48 } },
      { selector: 'node[type = "person"]', style: { shape: "ellipse", "background-color": css.getPropertyValue("--info").trim() } },
      { selector: 'node[type = "meeting"]', style: { shape: "diamond", "background-color": css.getPropertyValue("--muted").trim() } },
      { selector: 'node[type = "evidence"]', style: { shape: "hexagon", "background-color": css.getPropertyValue("--warn").trim() } },
      { selector: 'node[status = "blocked"]', style: { "border-color": css.getPropertyValue("--err").trim(), "border-width": 5 } },
      { selector: 'node[status = "done"]', style: { opacity: 0.55 } },
      {
        selector: "edge",
        style: {
          label: "data(label)",
          "font-size": 8,
          color: css.getPropertyValue("--muted").trim(),
          width: 1.5,
          "line-color": css.getPropertyValue("--border").trim(),
          "target-arrow-color": css.getPropertyValue("--border").trim(),
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
        },
      },
      { selector: 'edge[reviewState = "proposed"]', style: { "line-style": "dashed", opacity: 0.65 } },
      { selector: ":selected", style: { "border-color": css.getPropertyValue("--warn").trim(), "border-width": 5 } },
    ],
    layout: { name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 110 },
  });
  if (prior) {
    cy.zoom(prior.zoom);
    cy.pan(prior.pan);
  } else {
    cy.fit(undefined, 36);
  }
  cy.on("tap", "node", (event) => selectNode(event.target.id()));
  cy.on("tap", "edge", (event) => selectEdge(event.target.id()));
  renderList();
  renderPeopleList();
  const proposalCount = payload.edges.filter((edge) => edge.reviewState === "proposed").length;
  const summary = payload.stats
    ? `${payload.stats.nodes} total items · ${payload.stats.edges} relationships · ${payload.stats.proposals} proposals · ${payload.stats.overdue} overdue · ${payload.stats.orphans} orphaned links`
    : `${payload.nodes.length} items · ${payload.edges.length} relationships · ${proposalCount} proposals`;
  message.classList.remove("graph-error");
  message.innerHTML = `${summary}${
    payload.truncated ? " · view capped" : ""
  }${payload.nextCursor ? ' · <button type="button" class="link-button" id="graph-more">load more</button>' : ""}`;
  document.getElementById("graph-more")?.addEventListener("click", () => void load(payload.nextCursor));
  if (selectedId && payload.nodes.some((node) => node.id === selectedId)) selectNode(selectedId);
}

function selectNode(id: string): void {
  selectedId = id;
  const node = payload.nodes.find((item) => item.id === id);
  if (!node) return;
  const connected = payload.edges.filter((edge) => edge.fromId === id || edge.toId === id);
  detail.innerHTML = `<h2>${escapeHtml(node.type)}</h2><div class="pad">
    <h3>${escapeHtml(node.title)}</h3>
    <p>${escapeHtml(node.description ?? "No description.")}</p>
    <div class="graph-meta">${badge(node.status ?? "no status")} <span class="mono">v${node.version}</span>${
      node.due ? ` <span>due ${escapeHtml(node.due.slice(0, 10))}</span>` : ""
    }</div>
    <p class="mono muted">${escapeHtml(node.id)}</p>
    <button type="button" class="ghost" id="graph-expand-node">Expand 2 hops</button>
    ${
      config.writesEnabled && (!node.source || node.source.kind === "graph")
        ? '<button type="button" id="graph-edit-node">Edit</button>'
        : '<p class="muted">Projected source records are read-only.</p>'
    }
    <h3>Relationships</h3>
    ${connected.length ? connected.map(edgeHtml).join("") : '<p class="muted">No relationships.</p>'}
    ${config.writesEnabled ? `<details><summary>Add relationship</summary>
      <form id="graph-edge-form" class="graph-edge-form">
        <select name="type"><option value="depends_on">depends on</option><option value="part_of">part of</option><option value="assigned_to">assigned to</option><option value="related_to">related to</option><option value="supports">supports</option></select>
        <input name="toId" required placeholder="Target graph id">
        <input name="evidence" placeholder="Why these are linked">
        <button type="submit">Add</button>
      </form>
    </details>` : ""}
  </div>`;
  required("graph-expand-node").addEventListener("click", () => void expandNode(node.id));
  document.getElementById("graph-edit-node")?.addEventListener("click", () => openEditor(node.type, node));
  document.getElementById("graph-edge-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    void mutate({
      action: "create_edge",
      fromId: node.id,
      toId: String(data.get("toId") ?? ""),
      type: String(data.get("type") ?? ""),
      evidence: String(data.get("evidence") ?? ""),
    });
  });
  bindReviewButtons();
}

function selectEdge(id: string): void {
  selectedId = "";
  const edge = payload.edges.find((item) => item.id === id);
  if (!edge) return;
  detail.innerHTML = `<h2>Relationship</h2><div class="pad">
    <h3>${escapeHtml(edge.type.replaceAll("_", " "))}</h3>
    <p class="mono">${escapeHtml(edge.fromId)}<br>→ ${escapeHtml(edge.toId)}</p>
    <p>${escapeHtml(edge.evidence ?? "No evidence recorded.")}</p>
    <div>${badge(edge.reviewState)} <span class="mono">v${edge.version}</span></div>
    ${reviewActions(edge)}
  </div>`;
  bindReviewButtons();
}

function edgeHtml(edge: EdgeDoc): string {
  const otherId = edge.fromId === selectedId ? edge.toId : edge.fromId;
  const other = payload.nodes.find((node) => node.id === otherId);
  return `<div class="graph-relation"><strong>${escapeHtml(edge.type.replaceAll("_", " "))}</strong>
    <button type="button" class="link-button graph-select-node" data-node-id="${escapeHtml(otherId)}">${escapeHtml(other?.title ?? otherId)}</button>
    ${badge(edge.reviewState)}${reviewActions(edge)}</div>`;
}

function reviewActions(edge: EdgeDoc): string {
  if (edge.reviewState !== "proposed") return "";
  return `<span class="graph-review">
    <button type="button" data-review="accepted" data-edge-id="${escapeHtml(edge.id)}" data-version="${edge.version}">Accept</button>
    <button type="button" class="ghost" data-review="rejected" data-edge-id="${escapeHtml(edge.id)}" data-version="${edge.version}">Reject</button>
  </span>`;
}

function bindReviewButtons(): void {
  detail.querySelectorAll<HTMLElement>("[data-node-id]").forEach((button) => {
    button.addEventListener("click", () => selectNode(button.dataset.nodeId ?? ""));
  });
  detail.querySelectorAll<HTMLButtonElement>("[data-review]").forEach((button) => {
    button.addEventListener("click", () =>
      void mutate({
        action: "review_edge",
        id: button.dataset.edgeId,
        reviewState: button.dataset.review,
        expectedVersion: Number(button.dataset.version),
      })
    );
  });
}

function renderList(): void {
  const matched = payload.matchedIds
    ? new Set(payload.matchedIds)
    : new Set(payload.nodes.map((node) => node.id));
  const listedNodes = payload.nodes.filter((node) => matched.has(node.id));
  if (!listedNodes.length) {
    list.innerHTML = '<p class="muted">No execution items match these filters.</p>';
    return;
  }
  list.innerHTML = `<ul class="graph-accessible-list">${listedNodes
    .map(
      (node) =>
        `<li><button type="button" data-node-id="${escapeHtml(node.id)}">${escapeHtml(node.title)}</button> ${badge(
          node.type
        )} ${badge(node.status ?? "no status")}${node.due ? ` <span>due ${escapeHtml(node.due.slice(0, 10))}</span>` : ""}</li>`
    )
    .join("")}</ul>`;
  list.querySelectorAll<HTMLButtonElement>("[data-node-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.nodeId ?? "";
      cy?.getElementById(id).select();
      cy?.animate({ center: { eles: cy.getElementById(id) }, duration: 250 });
      selectNode(id);
    });
  });
}

function openEditor(type: NodeType, node?: NodeDoc): void {
  if (type !== "project" && type !== "task") return;
  const controls = form.elements as typeof form.elements & {
    id: HTMLInputElement;
    version: HTMLInputElement;
    type: HTMLSelectElement;
    status: HTMLSelectElement;
    title: HTMLInputElement;
    description: HTMLTextAreaElement;
    ownerPersonId: HTMLInputElement;
    due: HTMLInputElement;
    projectId: HTMLInputElement;
  };
  form.reset();
  required("graph-dialog-title").textContent = `${node ? "Edit" : "New"} ${type}`;
  controls.id.value = node?.id ?? "";
  controls.version.value = node ? String(node.version) : "";
  controls.type.value = type;
  controls.type.disabled = Boolean(node);
  controls.status.value = node?.status ?? (type === "task" ? "open" : "planned");
  controls.title.value = node?.title ?? "";
  controls.description.value = node?.description ?? "";
  controls.ownerPersonId.value = node?.ownerPersonId ?? "";
  controls.due.value = node?.due?.slice(0, 10) ?? "";
  controls.projectId.closest("label")?.toggleAttribute("hidden", type !== "task" || Boolean(node));
  dialog.showModal();
  controls.title.focus();
}

async function saveForm(): Promise<void> {
  const data = new FormData(form);
  const id = String(data.get("id") ?? "");
  const saved = await mutate({
    action: id ? "update_node" : "create_node",
    id: id || undefined,
    expectedVersion: data.get("version") ? Number(data.get("version")) : undefined,
    type: data.get("type"),
    status: data.get("status"),
    title: data.get("title"),
    description: data.get("description"),
    ownerPersonId: data.get("ownerPersonId"),
    due: data.get("due"),
    projectId: data.get("projectId"),
  });
  if (saved) dialog.close();
}

async function mutate(input: Record<string, unknown>): Promise<boolean> {
  message.textContent = "Saving…";
  const response = await fetch(config.api, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...input, csrf: config.csrf, scope: config.scope }),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) {
    message.textContent =
      response.status === 403
        ? "Your edit session expired. Reload this page and try again."
        : result.error ?? `Save failed (${response.status}).`;
    message.classList.add("graph-error");
    return false;
  }
  await load();
  return true;
}

function mergePayload(a: Payload, b: Payload): Payload {
  const nodes = new Map([...a.nodes, ...b.nodes].map((node) => [node.id, node]));
  const edges = new Map([...a.edges, ...b.edges].map((edge) => [edge.id, edge]));
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: b.truncated,
    nextCursor: b.nextCursor,
    stats: b.stats ?? a.stats,
    matchedIds: [...new Set([...(a.matchedIds ?? []), ...(b.matchedIds ?? [])])],
  };
}

async function expandNode(id: string): Promise<void> {
  message.textContent = "Expanding neighborhood…";
  try {
    const params = new URLSearchParams({
      focus: id,
      depth: "2",
      limit: "100",
      proposed: String(proposals.checked),
    });
    const response = await fetch(`${config.api}?${params}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const result = (await response.json()) as Payload & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Expand failed (${response.status})`);
    payload = mergePayload(payload, result);
    render();
    selectNode(id);
  } catch (err) {
    message.textContent = (err as Error).message;
    message.classList.add("graph-error");
  }
}

function saveControls(): void {
  try {
    localStorage.setItem(
      "tb-graph-filters",
      JSON.stringify({
        q: search.value,
        type: typeFilter.value,
        status: statusFilter.value,
        proposals: proposals.checked,
        owner: ownerFilter.value,
      })
    );
  } catch {}
}

function restoreControls(): void {
  try {
    const saved = JSON.parse(localStorage.getItem("tb-graph-filters") ?? "{}") as Record<string, unknown>;
    search.value = String(saved.q ?? "");
    typeFilter.value = String(saved.type ?? "");
    statusFilter.value = String(saved.status ?? "");
    proposals.checked = saved.proposals !== false;
    ownerFilter.value = String(saved.owner ?? "");
  } catch {}
}

function persistViewport(): void {
  if (!cy) return;
  try {
    localStorage.setItem("tb-graph-viewport", JSON.stringify({ pan: cy.pan(), zoom: cy.zoom() }));
  } catch {}
}

function restoredViewport(): { pan: { x: number; y: number }; zoom: number } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem("tb-graph-viewport") ?? "null");
    if (value?.pan && Number.isFinite(value?.zoom)) return value;
  } catch {}
  return undefined;
}

function badge(value: string): string {
  return `<span class="pill">${escapeHtml(value)}</span>`;
}

function renderPeopleList(): void {
  const datalist = required<HTMLDataListElement>("graph-people");
  datalist.innerHTML = payload.nodes
    .filter((node) => node.type === "person")
    .map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.title)}</option>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing graph element #${id}`);
  return element as T;
}
