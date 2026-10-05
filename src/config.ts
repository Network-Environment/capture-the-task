/**
 * Runtime config loader. Config lives in /config (outside src/) so it ships
 * as plain JSON in the deploy zip and can be edited without a rebuild.
 * Resolution: CONFIG_DIR env → <cwd>/config → <repo root>/config.
 */
import fs from "node:fs";
import path from "node:path";

const candidates = [
  process.env.CONFIG_DIR,
  path.resolve(process.cwd(), "config"),
  path.resolve(__dirname, "..", "config"),      // dist/ → repo root
  path.resolve(__dirname, "..", "..", "config"), // dist/src/ layouts
].filter(Boolean) as string[];

const cache = new Map<string, unknown>();

/**
 * Boolean app setting. Bicep's string(bool) writes "True"/"False", operators
 * type "true"/"false", so parsing must be case-insensitive. Unset or
 * unrecognized values return the default.
 */
/**
 * Defaults used when an app setting is missing. These match the Bicep
 * parameters and the deploy workflow. A stripped environment must not fall
 * back to shadow mode or skip approvals.
 */
export const PRODUCTION_FLAG_DEFAULTS = {
  INTENT_GATEWAY_ENABLED: true,
  INTENT_SHADOW_MODE: false,
  CLARIFICATION_ENFORCEMENT_ENABLED: true,
  UNIFIED_ACTION_POLICY_ENABLED: true,
  LEGACY_TRIAGE_WRITES_ENABLED: false,
  INBOUND_QUALITY_GATE_ENABLED: true,
  EXECUTION_GRAPH_WRITES_ENABLED: false,
} as const;

export function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  return defaultValue;
}

export function loadConfig<T = unknown>(name: string): T {
  const key = name.endsWith(".json") ? name : `${name}.json`;
  if (cache.has(key)) return cache.get(key) as T;
  for (const dir of candidates) {
    const p = path.join(dir, key);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as T;
      cache.set(key, parsed);
      return parsed;
    }
  }
  throw new Error(`config ${key} not found in: ${candidates.join(", ")}`);
}
