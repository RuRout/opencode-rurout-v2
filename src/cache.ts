import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_FILE_CACHE_DIR = join(homedir(), ".cache", "opencode-rurout");
export const LEGACY_FILE_CACHE_PATTERN = /^models-[0-9a-f]+\.json$/i;

export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
}

export async function purgeLegacyFileCache(log?: (message: string) => void): Promise<number> {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(LEGACY_FILE_CACHE_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!LEGACY_FILE_CACHE_PATTERN.test(entry)) continue;
    try {
      await fs.unlink(join(LEGACY_FILE_CACHE_DIR, entry));
      removed += 1;
    } catch {
      // Best-effort: a locked or already-removed file must not break startup.
    }
  }
  if (removed > 0) {
    log?.(`[rurout] removed ${removed} stale model cache file(s) from ~/.cache/opencode-rurout`);
  }
  return removed;
}

// Last-known-good model list per key hash. Only model ids/metadata live here
// (never key material), so a restart or a freshly booted location can show
// the provider instantly instead of an empty picker while the gateway answers.
// Always refreshed live right after it is used. Name deliberately does not
// match LEGACY_FILE_CACHE_PATTERN, so the legacy purge leaves it alone.
export const MODEL_CACHE_DIR = LEGACY_FILE_CACHE_DIR;
const MODEL_CACHE_VERSION = 1;

function modelCachePath(apiKey: string): string {
  return join(MODEL_CACHE_DIR, `v2-models-${keyFingerprint(apiKey)}.json`);
}

export async function readModelCache<T>(apiKey: string): Promise<T[] | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(modelCachePath(apiKey), "utf8")) as {
      version?: number;
      models?: unknown;
    };
    if (raw?.version !== MODEL_CACHE_VERSION || !Array.isArray(raw.models)) return undefined;
    return raw.models as T[];
  } catch {
    return undefined;
  }
}

export async function writeModelCache(apiKey: string, models: unknown[]): Promise<void> {
  try {
    await fs.mkdir(MODEL_CACHE_DIR, { recursive: true });
    const target = modelCachePath(apiKey);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: MODEL_CACHE_VERSION, models }));
    await fs.rename(tmp, target);
  } catch {
    // Cache is an optimisation only; a write failure must never break sync.
  }
}

export async function removeModelCache(apiKey: string): Promise<void> {
  try {
    await fs.unlink(modelCachePath(apiKey));
  } catch {
    // Already gone.
  }
}
