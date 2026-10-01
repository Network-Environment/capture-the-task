/**
 * Repeated capability gaps become disabled MCP candidates. They are not
 * connected. An operator adds a URL and allowlist to mcp.servers.json only
 * when that system has an API the org actually uses.
 */
export interface GapSample {
  capability: string;
  limit?: string;
  request?: string;
}

export interface ConnectorCandidate {
  name: string;
  capability: string;
  count: number;
  entry: {
    name: string;
    transport: "http";
    url: string;
    enabled: false;
    allowTools: string[];
    confirmTools: string[];
    description: string;
  };
}

const REPEAT_AT = 2;

const ALREADY_COVERED = [
  "mail",
  "email",
  "calendar",
  "outlook",
  "file",
  "onedrive",
  "sharepoint",
  "smartsheet",
  "browser",
  "web search",
  "public page",
  "login",
  "sign in",
  "signed-in",
];

export function connectorSlug(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "";
}

export function connectorCandidates(
  gaps: GapSample[],
  existingServers: string[]
): ConnectorCandidate[] {
  const counts = new Map<string, { count: number; capability: string }>();
  for (const gap of gaps) {
    const capability = gap.capability.trim();
    const key = capability.toLowerCase();
    if (!key) continue;
    const row = counts.get(key) ?? { count: 0, capability };
    row.count += 1;
    counts.set(key, row);
  }
  const existing = new Set(existingServers.map((name) => name.toLowerCase()));
  const candidates: ConnectorCandidate[] = [];
  for (const row of counts.values()) {
    if (row.count < REPEAT_AT) continue;
    if (ALREADY_COVERED.some((word) => row.capability.toLowerCase().includes(word))) continue;
    const name = connectorSlug(row.capability);
    if (!name || existing.has(name)) continue;
    candidates.push({
      name,
      capability: row.capability,
      count: row.count,
      entry: {
        name,
        transport: "http",
        url: "",
        enabled: false,
        allowTools: [],
        confirmTools: [],
        description:
          `Candidate from ${row.count} unmet requests: ${row.capability}. ` +
          "Leave disabled until the API URL and read allowlist are known. Writes go in confirmTools.",
      },
    });
  }
  return candidates.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
