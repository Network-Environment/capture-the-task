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
let toolCache: McpToolRef[] | null = null;

/**
 * Every MCP call is bounded. A remote server that is restarting, redeploying,
 * or wedged must not hang the agent loop or the admin dashboard, which is what
 * a plain connect() does — it has no timeout of its own.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

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

async function connect(cfg: ServerConfig): Promise<Client> {
  const existing = clients.get(cfg.name);
  if (existing) return existing;

  const url = resolveServerUrl(cfg);
  if (!url) throw new Error(`${cfg.urlEnv ?? "url"} is not set`);

  const headers: Record<string, string> = {};
  if (cfg.authEnv && process.env[cfg.authEnv]) {
    headers["Authorization"] = `Bearer ${process.env[cfg.authEnv]}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const client = new Client({ name: "taskbrain", version: "0.1.0" });
  await withTimeout(client.connect(transport), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, cfg.name);
  clients.set(cfg.name, client);
  return client;
}

async function listTools(cfg: ServerConfig, client: Client) {
  return withTimeout(client.listTools(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, cfg.name);
}

/**
 * Discover tools from every enabled server. Cached per process, but only once
 * every server answered: caching a partial result would strand a server that
 * was merely asleep (or still deploying) until the next restart.
 */
export async function discoverMcpTools(): Promise<McpToolRef[]> {
  if (toolCache) return toolCache;
  const refs: McpToolRef[] = [];
  let complete = true;
  for (const cfg of (serversConfig.servers as ServerConfig[]).filter((s) => s.enabled)) {
    if (!resolveServerUrl(cfg)) {
      complete = false;
      continue;
    }
    try {
      const client = await connect(cfg);
      const { tools } = await listTools(cfg, client);
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
    } catch (err) {
      console.error(`[mcp] failed to connect to ${cfg.name}:`, err);
      // Degrade gracefully: the agent runs without that server's tools.
      complete = false;
    }
  }
  if (complete) toolCache = refs;
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
  error?: string;
  /** Timed out rather than refused — the server is slow, restarting, or wedged. */
  timedOut?: boolean;
}

/** Live connect check for the admin Integrations page. Does not log tokens. */
export async function mcpServerHealth(): Promise<McpServerHealth[]> {
  const out: McpServerHealth[] = [];
  for (const cfg of mcpServerCatalog()) {
    const tokenPresent = !!(cfg.authEnv && process.env[cfg.authEnv]);
    const url = resolveServerUrl(cfg) ?? (cfg.urlEnv ? `env:${cfg.urlEnv}` : cfg.url ?? "");
    if (!cfg.enabled) {
      out.push({
        name: cfg.name,
        enabled: false,
        url,
        authEnv: cfg.authEnv,
        tokenPresent,
        connected: false,
        toolCount: 0,
      });
      continue;
    }
    if (!resolveServerUrl(cfg)) {
      out.push({
        name: cfg.name,
        enabled: true,
        url,
        authEnv: cfg.authEnv,
        tokenPresent,
        connected: false,
        toolCount: 0,
        error: `${cfg.urlEnv ?? "url"} unset`,
      });
      continue;
    }
    try {
      const client = await connect(cfg);
      const { tools } = await listTools(cfg, client);
      const n = cfg.allowTools
        ? tools.filter((t) => cfg.allowTools!.includes(t.name)).length
        : tools.length;
      out.push({
        name: cfg.name,
        enabled: true,
        url,
        authEnv: cfg.authEnv,
        tokenPresent,
        connected: true,
        toolCount: n,
      });
    } catch (err) {
      out.push({
        name: cfg.name,
        enabled: true,
        url,
        authEnv: cfg.authEnv,
        tokenPresent,
        connected: false,
        toolCount: 0,
        error: (err as Error).message.slice(0, 180),
        timedOut: err instanceof McpTimeout,
      });
    }
  }
  return out;
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
