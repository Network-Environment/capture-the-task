import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { loadConfig } from "../config";

const API_BASE =
  process.env.PLAUD_API_BASE ?? "https://platform.plaud.ai/developer/api";
const REFRESH_URL =
  process.env.PLAUD_REFRESH_URL ??
  `${API_BASE}/oauth/third-party/access-token/refresh`;
const TOKEN_SECRET_NAME =
  process.env.PLAUD_TOKEN_SECRET_NAME ?? "plaud-oauth-tokens";

export interface PlaudAccount {
  id: string;
  organizerId: string;
  organizerName?: string;
}

interface PlaudAccountsConfig {
  accounts?: PlaudAccount[];
}

export interface PlaudTokenSet {
  access_token?: string;
  refresh_token: string;
  token_type?: string;
  expires_at?: number;
}

export type PlaudTokenMap = Record<string, PlaudTokenSet>;

export interface PlaudSourceBlock {
  data_type?: string;
  data_content?: string;
  data_link?: string;
}

export interface PlaudFile {
  id: string;
  name?: string;
  created_at?: string;
  start_at?: string;
  duration?: number;
  serial_number?: string;
  source_list?: PlaudSourceBlock[];
}

interface PlaudListResponse {
  data?: PlaudFile[];
  page?: number;
  total_pages?: number;
  has_next?: boolean;
}

export interface PlaudTokenStore {
  load(): Promise<PlaudTokenMap>;
  save(tokens: PlaudTokenMap): Promise<void>;
}

class KeyVaultTokenStore implements PlaudTokenStore {
  private readonly client: SecretClient;

  constructor(vaultUrl: string) {
    this.client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  }

  async load(): Promise<PlaudTokenMap> {
    const secret = await this.client.getSecret(TOKEN_SECRET_NAME);
    if (!secret.value) throw new Error("Plaud token secret is empty.");
    return parseTokenMap(secret.value);
  }

  async save(tokens: PlaudTokenMap): Promise<void> {
    await this.client.setSecret(TOKEN_SECRET_NAME, JSON.stringify(tokens));
  }
}

class EnvTokenStore implements PlaudTokenStore {
  async load(): Promise<PlaudTokenMap> {
    const value = process.env.PLAUD_TOKEN_JSON;
    if (!value) throw new Error("PLAUD_TOKEN_JSON is empty.");
    return parseTokenMap(value);
  }

  async save(tokens: PlaudTokenMap): Promise<void> {
    process.env.PLAUD_TOKEN_JSON = JSON.stringify(tokens);
  }
}

function parseTokenMap(value: string): PlaudTokenMap {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plaud token secret must be a JSON object.");
  }
  return parsed as PlaudTokenMap;
}

function tokenStore(): PlaudTokenStore {
  const vaultUrl = process.env.PLAUD_KEY_VAULT_URL;
  return vaultUrl ? new KeyVaultTokenStore(vaultUrl) : new EnvTokenStore();
}

function apiTimestamp(value?: string): number {
  if (!value) return 0;
  const normalized =
    /\d{2}:\d{2}/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
      ? `${value}Z`
      : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function listPlaudAccounts(): PlaudAccount[] {
  if ((process.env.PLAUD_INGEST_ENABLED ?? "false").toLowerCase() !== "true") {
    return [];
  }
  const config = loadConfig<PlaudAccountsConfig>("plaud-accounts");
  return (config.accounts ?? []).filter(
    (account) => account.id && account.organizerId
  );
}

export function recentPlaudFiles(
  files: PlaudFile[],
  days = 30,
  now = Date.now()
): PlaudFile[] {
  const cutoff = now - days * 86_400_000;
  return files.filter(
    (file) => apiTimestamp(file.start_at ?? file.created_at) >= cutoff
  );
}

export function hasPlaudTranscript(file: PlaudFile): boolean {
  return (file.source_list ?? []).some(
    (source) => source.data_type === "transaction"
  );
}

export function renderPlaudTranscript(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return content;
    return parsed
      .map((segment) => {
        if (!segment || typeof segment !== "object") return "";
        const row = segment as Record<string, unknown>;
        const speaker =
          typeof row.speaker === "string" && row.speaker
            ? `${row.speaker}: `
            : "";
        const text =
          typeof row.content === "string"
            ? row.content
            : typeof row.topic === "string"
              ? row.topic
              : "";
        return `${speaker}${text}`.trim();
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return content;
  }
}

export function plaudTranscriptId(accountId: string, recordingId: string): string {
  return `plaud:${accountId}:${recordingId}`;
}

export function parsePlaudTranscriptId(
  value: string
): { accountId: string; recordingId: string } | undefined {
  if (!value.startsWith("plaud:")) return undefined;
  const split = value.indexOf(":", "plaud:".length);
  if (split < 0) return undefined;
  const accountId = value.slice("plaud:".length, split);
  const recordingId = value.slice(split + 1);
  return accountId && recordingId ? { accountId, recordingId } : undefined;
}

export class PlaudClient {
  private cachedTokens?: PlaudTokenMap;

  constructor(
    private readonly accountId: string,
    private readonly store: PlaudTokenStore = tokenStore(),
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private async accessToken(): Promise<string> {
    const tokens = this.cachedTokens ?? (await this.store.load());
    this.cachedTokens = tokens;
    const current = tokens[this.accountId];
    if (!current?.refresh_token) {
      throw new Error(
        `Plaud re-login required: no token for account "${this.accountId}".`
      );
    }
    if (
      current.access_token &&
      (current.expires_at == null ||
        current.expires_at > Date.now() + 60_000)
    ) {
      return current.access_token;
    }

    const response = await this.fetcher(REFRESH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ refresh_token: current.refresh_token }),
    });
    if (!response.ok) {
      throw new Error(
        `Plaud re-login required: token refresh failed (${response.status}).`
      );
    }
    const body = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error("Plaud token refresh returned no access token.");
    }
    const refreshed: PlaudTokenSet = {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? current.refresh_token,
      token_type: body.token_type ?? "Bearer",
      expires_at: body.expires_in
        ? Date.now() + body.expires_in * 1000
        : undefined,
    };
    this.cachedTokens = { ...tokens, [this.accountId]: refreshed };
    await this.store.save(this.cachedTokens);
    return refreshed.access_token!;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${API_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await this.accessToken()}`,
      },
    });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? " Plaud re-login may be required."
          : "";
      throw new Error(`Plaud API failed (${response.status}).${hint}`);
    }
    return (await response.json()) as T;
  }

  async listFiles(page = 1, pageSize = 100): Promise<PlaudFile[]> {
    const result = await this.request<PlaudListResponse>(
      `/open/third-party/files/?page=${page}&page_size=${pageSize}`
    );
    return result.data ?? [];
  }

  async listRecentFiles(maxPages = 5): Promise<PlaudFile[]> {
    const files: PlaudFile[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.listFiles(page, 100);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  async getFile(fileId: string): Promise<PlaudFile> {
    return this.request<PlaudFile>(
      `/open/third-party/files/${encodeURIComponent(fileId)}`
    );
  }

  async getTranscript(fileId: string): Promise<string> {
    const file = await this.getFile(fileId);
    const block = (file.source_list ?? []).find(
      (source) => source.data_type === "transaction"
    );
    if (!block) throw new Error("Plaud transcript is not ready.");
    let content = block.data_content ?? "";
    if (!content && block.data_link) {
      const response = await this.fetcher(block.data_link);
      if (!response.ok) {
        throw new Error(
          `Plaud transcript download failed (${response.status}).`
        );
      }
      content = await response.text();
    }
    if (!content) throw new Error("Plaud transcript is empty.");
    return renderPlaudTranscript(content);
  }
}
