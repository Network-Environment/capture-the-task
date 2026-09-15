/**
 * MCP integration layer. Connects to remote MCP servers (Streamable HTTP)
 * declared in config/mcp.servers.json, discovers their tools, and adapts them
 * to the OpenAI tool-calling shape the agent loop uses.
 *
 * Smartsheet's hosted server (https://mcp.smartsheet.com) is the first entry;
 * any other MCP-compliant service is one more config entry.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { loadConfig } from "../config";
const serversConfig = loadConfig<{ servers: unknown[] }>("mcp.servers");

export interface ServerConfig {
  name: string;
  transport: "http";
  url?: string;
  urlEnv?: string;
  authEnv?: string;
  enabled: boolean;
  timeoutMs?: number;
  allowTools?: string[];
  confirmTools?: string[];
  description?: string;
}

interface McpToolRef {
  server: string;
  client: Client;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const clients = new Map<string, Client>();
const connectionInflight = new Map<string, Promise<Client>>();
const toolListInflight = new Map<
  string,
  Promise<Awaited<ReturnType<Client["listTools"]>>>
>();
let toolCache: McpToolRef[] | null = null;

/**
 * Every MCP call is bounded. A remote server that is restarting, redeploying,
 * or wedged must not hang the agent loop or the admin dashboard, which is what
 * a plain connect() does — it has no timeout of its own.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Admin HTML must not wait for scale-to-zero MCP (browser allowlist is 25s). */
export const ADMIN_MCP_PROBE_MS = 3_500;
const HEALTH_TTL_MS = 45_000;

export class McpTimeout extends Error {
  constructor(server: string, ms: number) {
    super(`${server} did not answer within ${ms}ms`);
    this.name = "McpTimeout";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, server: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpTimeout(server, ms)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export function resolveServerUrl(cfg: ServerConfig): string | undefined {
  if (cfg.urlEnv) {
    const fromEnv = process.env[cfg.urlEnv]?.trim();
    if (fromEnv) return fromEnv;
    return undefined;
  }
  const u = cfg.url?.trim();
  return u || undefined;
}

function timeoutMsFor(cfg: ServerConfig, override?: number): number {
  return override ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

async function connect(cfg: ServerConfig, probeMs?: number): Promise<Client> {
  const existing = clients.get(cfg.name);
  if (existing) return existing;

  const url = resolveServerUrl(cfg);
  if (!url) throw new Error(`${cfg.urlEnv ?? "url"} is not set`);

  let pending = connectionInflight.get(cfg.name);
  if (!pending) {
    const headers: Record<string, string> = {};
    if (cfg.authEnv && process.env[cfg.authEnv]) {
      headers["Authorization"] = `Bearer ${process.env[cfg.authEnv]}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
    });
    const client = new Client({ name: "taskbrain", version: "0.1.0" });
    pending = withTimeout(
      client.connect(transport).then(() => {
        clients.set(cfg.name, client);
        return client;
      }),
      cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cfg.name
    )
      .catch(async (err) => {
        await client.close().catch(() => undefined);
        throw err;
      })
      .finally(() => {
        connectionInflight.delete(cfg.name);
      });
    connectionInflight.set(cfg.name, pending);
  }
  return probeMs
    ? withTimeout(pending, probeMs, cfg.name)
    : pending;
}

async function listTools(cfg: ServerConfig, client: Client, probeMs?: number) {
  let pending = toolListInflight.get(cfg.name);
  if (!pending) {
    pending = withTimeout(
      client.listTools(),
      cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cfg.name
    ).finally(() => {
      toolListInflight.delete(cfg.name);
    });
    toolListInflight.set(cfg.name, pending);
  }
  return probeMs
    ? withTimeout(pending, timeoutMsFor(cfg, probeMs), cfg.name)
    : pending;
}

/**
 * Discover tools from every enabled server. Cached per process, but only once
 * every server answered: caching a partial result would strand a server that
 * was merely asleep (or still deploying) until the next restart.
 */
export async function discoverMcpTools(): Promise<McpToolRef[]> {
  if (toolCache) return toolCache;
  const enabled = (serversConfig.servers as ServerConfig[]).filter((s) => s.enabled);
  const results = await Promise.all(
    enabled.map(async (cfg) => {
      if (!resolveServerUrl(cfg)) return { ok: false, refs: [] as McpToolRef[] };
      try {
        const client = await connect(cfg);
        const { tools } = await listTools(cfg, client);
        const refs: McpToolRef[] = [];
        for (const t of tools) {
          if (cfg.allowTools && !cfg.allowTools.includes(t.name)) continue;
          refs.push({
            server: cfg.name,
            client,
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
          });
        }
        return { ok: true, refs };
      } catch (err) {
        console.error(`[mcp] failed to connect to ${cfg.name}:`, err);
        return { ok: false, refs: [] as McpToolRef[] };
      }
    })
  );
  const refs = results.flatMap((row) => row.refs);
  if (results.every((row) => row.ok)) toolCache = refs;
  return refs;
}

/** Namespaced OpenAI-shaped tool definitions: smartsheet__search etc. */
export async function mcpToolDefinitions(): Promise<ChatCompletionTool[]> {
  const refs = await discoverMcpTools();
  return refs.map((r) => ({
    type: "function" as const,
    function: {
      name: `${r.server}__${r.name}`,
      description: `[${r.server}] ${r.description ?? r.name}`,
      parameters: r.inputSchema,
    },
  }));
}

export function mcpServerCatalog(): ServerConfig[] {
  return (serversConfig.servers as ServerConfig[]) ?? [];
}

export interface McpServerHealth {
  name: string;
  enabled: boolean;
  url: string;
  authEnv?: string;
  tokenPresent: boolean;
  connected: boolean;
  toolCount: number;
  toolNames?: string[];
  error?: string;
  /** Timed out rather than refused — the server is slow, restarting, or wedged. */
  timedOut?: boolean;
  /** Config snapshot only; live probe has not finished. */
  pending?: boolean;
}

let healthCache: { at: number; value: McpServerHealth[] } | undefined;
let healthInflight: Promise<McpServerHealth[]> | undefined;

function baseHealth(cfg: ServerConfig): Omit<McpServerHealth, "connected" | "toolCount"> {
  return {
    name: cfg.name,
    enabled: cfg.enabled,
    url: resolveServerUrl(cfg) ?? (cfg.urlEnv ? `env:${cfg.urlEnv}` : cfg.url ?? ""),
    authEnv: cfg.authEnv,
    tokenPresent: !!(cfg.authEnv && process.env[cfg.authEnv]),
  };
}

/** Instant, no network — what the admin HTML can render on first paint. */
export function mcpServerSnapshot(): McpServerHealth[] {
  return mcpServerCatalog().map((cfg) => {
    const base = baseHealth(cfg);
    if (!cfg.enabled) return { ...base, connected: false, toolCount: 0 };
    if (!resolveServerUrl(cfg)) {
      return {
        ...base,
        connected: false,
        toolCount: 0,
        error: `${cfg.urlEnv ?? "url"} unset`,
      };
    }
    return {
      ...base,
      connected: false,
      toolCount: cfg.allowTools?.length ?? 0,
      pending: true,
    };
  });
}

async function probeServer(cfg: ServerConfig, probeMs: number): Promise<McpServerHealth> {
  const base = baseHealth(cfg);
  if (!cfg.enabled) return { ...base, connected: false, toolCount: 0 };
  if (!resolveServerUrl(cfg)) {
    return {
      ...base,
      connected: false,
      toolCount: 0,
      error: `${cfg.urlEnv ?? "url"} unset`,
    };
  }
  try {
    const client = await connect(cfg, probeMs);
    const { tools } = await listTools(cfg, client, probeMs);
    const allowed = cfg.allowTools
      ? tools.filter((t) => cfg.allowTools!.includes(t.name))
      : tools;
    return {
      ...base,
      connected: true,
      toolCount: allowed.length,
      toolNames: allowed.map((t) => t.name),
    };
  } catch (err) {
    return {
      ...base,
      connected: false,
      toolCount: 0,
      error: (err as Error).message.slice(0, 180),
      timedOut: err instanceof McpTimeout,
    };
  }
}

/** Live connect check for the admin Integrations page. Does not log tokens. */
export async function mcpServerHealth(
  opts: { timeoutMs?: number; force?: boolean } = {}
): Promise<McpServerHealth[]> {
  const now = Date.now();
  if (!opts.force && healthCache && now - healthCache.at < HEALTH_TTL_MS) {
    return healthCache.value;
  }
  if (!opts.force && healthInflight) return healthInflight;
  const probeMs = opts.timeoutMs ?? ADMIN_MCP_PROBE_MS;
  healthInflight = Promise.all(mcpServerCatalog().map((cfg) => probeServer(cfg, probeMs)))
    .then((value) => {
      healthCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      healthInflight = undefined;
    });
  return healthInflight;
}

export function isMcpTool(name: string): boolean {
  return name.includes("__");
}

export async function callMcpTool(
  qualifiedName: string,
  args: Record<string, unknown>
): Promise<string> {
  const [server, ...rest] = qualifiedName.split("__");
  const toolName = rest.join("__");
  const refs = await discoverMcpTools();
  const ref = refs.find((r) => r.server === server && r.name === toolName);
  if (!ref) return `Tool ${qualifiedName} not found.`;

  const result = await ref.client.callTool({ name: toolName, arguments: args });
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text)
    .join("\n");
  return text || JSON.stringify(result.content ?? {});
}
