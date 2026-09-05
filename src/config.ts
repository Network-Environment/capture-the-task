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
