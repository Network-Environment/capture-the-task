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

interface ServerConfig {
  name: string;
  transport: "http";
  url: string;
  authEnv?: string;
  enabled: boolean;
  allowTools?: string[];
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

async function connect(cfg: ServerConfig): Promise<Client> {
  const existing = clients.get(cfg.name);
  if (existing) return existing;

  const headers: Record<string, string> = {};
  if (cfg.authEnv && process.env[cfg.authEnv]) {
    headers["Authorization"] = `Bearer ${process.env[cfg.authEnv]}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers },
  });
  const client = new Client({ name: "taskbrain", version: "0.1.0" });
  await client.connect(transport);
  clients.set(cfg.name, client);
  return client;
}

/** Discover tools from every enabled server. Cached per process. */
export async function discoverMcpTools(): Promise<McpToolRef[]> {
  if (toolCache) return toolCache;
  const refs: McpToolRef[] = [];
  for (const cfg of (serversConfig.servers as ServerConfig[]).filter((s) => s.enabled)) {
    try {
      const client = await connect(cfg);
      const { tools } = await client.listTools();
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
    }
  }
  toolCache = refs;
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
