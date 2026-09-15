/**
 * Application-permission Graph client (App Service MSI). Used to write another
 * person's To Do / Planner and to fall back to 1:1 or channel messages when
 * we have no Bot Framework conversation reference.
 */
import { DefaultAzureCredential } from "@azure/identity";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "https://graph.microsoft.com/.default";

let cached: { token: string; exp: number } | undefined;
const cred = new DefaultAzureCredential();

export async function graphAppToken(): Promise<string> {
  if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
  const t = await cred.getToken(SCOPE);
  if (!t?.token) throw new Error("graph app token unavailable");
  cached = { token: t.token, exp: t.expiresOnTimestamp ?? Date.now() + 50 * 60_000 };
  return t.token;
}

export async function graphAppFetch(
  path: string,
  init: RequestInit & { extraHeaders?: Record<string, string> } = {}
): Promise<Response> {
  const token = await graphAppToken();
  const { extraHeaders, ...rest } = init;
  return fetch(`${GRAPH}${path.startsWith("/") ? path : `/${path}`}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

export async function graphAppJson<T>(
  path: string,
  init: RequestInit & { extraHeaders?: Record<string, string> } = {}
): Promise<T> {
  const res = await graphAppFetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`graph ${res.status} ${path}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
