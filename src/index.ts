import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
} from "./constants.js";
import { fetchGatewayModels, type GatewayModel } from "./discovery.js";
import { keyFingerprint, purgeLegacyFileCache } from "./cache.js";
import { displayName, effortSuffix, familyOf, isImage, isReasoning, lookup, stripEffortSuffix } from "./fallback.js";
import { appendFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RuroutOptions {
  baseURL?: string;
}

type AnyRecord = Record<string, any>;

interface PluginContext {
  options?: unknown;
  catalog: {
    transform: (cb: (draft: AnyRecord) => void) => Promise<unknown>;
    reload: () => Promise<unknown>;
  };
  integration: {
    transform: (cb: (draft: AnyRecord) => void) => Promise<unknown>;
    connection: {
      active: (id: string) => Promise<AnyRecord | undefined>;
      resolve: (connection: AnyRecord) => Promise<AnyRecord | undefined>;
    };
  };
  aisdk: {
    hook: (name: string, cb: (event: AnyRecord) => Promise<void> | void) => Promise<unknown>;
  };
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<AnyRecord>;
  };
}

interface PluginDef {
  id: string;
  setup: (ctx: PluginContext) => Promise<(() => Promise<void> | void) | void>;
}

function baseURLFrom(opts: RuroutOptions): string {
  const raw = opts.baseURL ?? process.env.RUROUT_BASE_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function credentialKey(credential: AnyRecord | undefined): string {
  if (!credential || typeof credential !== "object") return "";
  if (credential.type === "key" && typeof credential.key === "string") return credential.key;
  if (typeof (credential as { apiKey?: unknown }).apiKey === "string") {
    return (credential as { apiKey: string }).apiKey;
  }
  return "";
}

/**
 * Single source of truth for "which key is active right now".
 * Always resolved fresh — never trusted from event payloads (the
 * `integration.connection.updated` event only carries `{ integrationID }`,
 * no key material), so every sync path observes the same state.
 */
async function getActiveKey(ctx: PluginContext): Promise<string> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return process.env.RUROUT_API_KEY ?? "";
    if (connection.type === "env" && typeof connection.name === "string") {
      return process.env[connection.name] ?? process.env.RUROUT_API_KEY ?? "";
    }
    const credential = await ctx.integration.connection.resolve(connection);
    return credentialKey(credential) || process.env.RUROUT_API_KEY || "";
  } catch {
    return process.env.RUROUT_API_KEY ?? "";
  }
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rejected|invalid or disabled/i.test(msg);
}

function toModel(
  canonical: string,
  apiId: string,
  display: string | undefined,
  providerID: string,
  effort: boolean,
): AnyRecord {
  const fallback = lookup(canonical);
  const image = isImage(canonical);
  const text = !canonical.startsWith("gpt-image-");
  const input = fallback.input > 0 ? fallback.input : 1;
  const output = fallback.outputCost > 0 ? fallback.outputCost : 5;
  return {
    id: canonical,
    modelID: apiId,
    providerID,
    name: displayName(apiId, display).startsWith("RuRout")
      ? displayName(apiId, display)
      : `RuRout ${displayName(apiId, display)}`,
    family: familyOf(canonical),
    capabilities: {
      tools: !image && text,
      input: image ? ["text", "image"] : ["text"],
      output: image || !text ? ["image"] : ["text"],
    },
    variants: effort
      ? [
          { id: "low", settings: { reasoningEffort: "low" } },
          { id: "medium", settings: { reasoningEffort: "medium" } },
          { id: "high", settings: { reasoningEffort: "high" } },
        ]
      : [],
    time: { released: 0 },
    cost: [
      {
        input,
        output,
        cache: { read: fallback.cacheRead ?? 0, write: 0 },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: fallback.context, output: fallback.output },
    settings: { reasoning: isReasoning(apiId) },
  };
}

function pickTransport(ids: string[]): string {
  const rank = (id: string): number => {
    const suffix = effortSuffix(id);
    if (suffix === "tiered") return 0;
    if (suffix === "high") return 1;
    if (!suffix) return 2;
    if (suffix === "medium") return 3;
    if (suffix === "low") return 4;
    return 5;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))[0]!;
}

function buildModels(live: GatewayModel[]): AnyRecord[] {
  const byId = new Map(live.map((model) => [model.id, model]));
  const groups = new Map<string, GatewayModel[]>();
  for (const entry of byId.values()) {
    const suffix = effortSuffix(entry.id);
    const base = suffix ? stripEffortSuffix(entry.id) : entry.id;
    const group = groups.get(base) ?? [];
    group.push(entry);
    groups.set(base, group);
  }
  const models: AnyRecord[] = [];
  for (const [base, entries] of groups) {
    const family = entries.length > 1 || entries.some((entry) => effortSuffix(entry.id));
    if (!family) {
      const entry = entries[0]!;
      const result = toModel(entry.id, entry.id, entry.display_name, PROVIDER_ID, false);
      result.display = entry.display_name ?? entry.id;
      models.push(result);
      continue;
    }
    const transport = pickTransport(entries.map((entry) => entry.id));
    const transportEntry = byId.get(transport);
    const result = toModel(base, transport, transportEntry?.display_name, PROVIDER_ID, true);
    result.display = transportEntry?.display_name ?? base;
    models.push(result);
  }
  return models;
}

// ─── Single-path key sync ────────────────────────────────────────────────────
// One rule for every trigger (startup, account event, poll, hourly, pre-request):
//   key selected → models rebuilt from scratch for THAT key, atomically.
//
// Previous generations of this file had four overlapping paths (event hint key,
// 5s poll with its own compare, hourly with clearFirst, sdk-hook settle loop)
// that could interleave: a slow fetch for key A would overwrite a fresh list
// for key B, and the catalog kept showing the old key's models for seconds
// after a switch. Now there is exactly one `sync()` and one serial queue.
// Stale results are discarded by re-resolving the active key after the fetch.

const POLL_MS = 5_000;
const HOURLY_MS = 60 * 60 * 1000;
const SDK_WAIT_MS = 30_000;
const PER_KEY_CACHE_LIMIT = 20;
const TRACE_PATH = join(tmpdir(), "rurout-sync.log");
const TRACE_MAX_BYTES = 200_000;

// Append-only debug trace (no key material — hashes only). Proves which sync
// ran, what it decided, and why. Capped so it can stay on permanently.
function trace(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  void (async () => {
    try {
      let size = 0;
      try {
        size = (await stat(TRACE_PATH)).size;
      } catch {
        // Missing file — will be created below.
      }
      if (size >= TRACE_MAX_BYTES) {
        await writeFile(TRACE_PATH, line);
      } else {
        await appendFile(TRACE_PATH, line);
      }
    } catch {
      // Tracing must never break syncing.
    }
  })();
}

function shortHash(key: string): string {
  return key ? keyFingerprint(key).slice(0, 8) : "(none)";
}

const plugin: PluginDef = {
  id: "rurout",
  setup: async (ctx) => {
    const opts = ((ctx as AnyRecord).options ?? {}) as RuroutOptions;
    const baseURL = baseURLFrom(opts);

    await ctx.integration.transform((draft: AnyRecord) => {
      draft.update(PROVIDER_ID, (ref: AnyRecord) => {
        ref.name = PROVIDER_NAME;
      });
      draft.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "API Key" },
      });
    });

    await ctx.catalog.transform((draft: AnyRecord) => {
      draft.provider.update(PROVIDER_ID, (provider: AnyRecord) => {
        provider.name = PROVIDER_NAME;
        provider.package = PROVIDER_PACKAGE;
        provider.settings = { ...(provider.settings ?? {}), baseURL };
      });
    });

    await purgeLegacyFileCache();

    let disposed = false;
    // Last key fully written to the catalog (with its own models, or an empty
    // list for a rejected key). `undefined` = never synced since startup.
    let syncedKey: string | undefined;
    // Last-known-good models per key hash. Lets a repeated switch render
    // instantly from memory instead of waiting out a network round-trip.
    // Model ids are not secrets; keyed by hash so raw keys never linger here.
    const perKeyModels = new Map<string, AnyRecord[]>();
    // Coalescing single-flight: at most one sync runs, at most one waits.
    // Burst triggers merge into the waiting slot instead of piling full
    // fetches behind each other (a slow gateway + 5s poll used to grow an
    // unbounded queue and delay a real switch by the whole backlog).
    // `flight` is the in-flight discovery fetch: a newer user-intent trigger
    // (account event, pre-request) aborts it so a stale fetch never blocks
    // the fresh one — last writer wins.
    let worker: Promise<void> | null = null;
    let wanted: { reason: string; force: boolean } | null = null;
    let flight: AbortController | null = null;

    function remember(key: string, models: AnyRecord[]): void {
      perKeyModels.set(keyFingerprint(key), models);
      while (perKeyModels.size > PER_KEY_CACHE_LIMIT) {
        const oldest = perKeyModels.keys().next();
        if (oldest.done) break;
        perKeyModels.delete(oldest.value);
      }
    }

    async function writeCatalog(key: string, models: AnyRecord[]): Promise<void> {
      if (disposed) return;
      const wanted = new Set(models.map((model) => model.id));
      await ctx.catalog.transform((draft: AnyRecord) => {
        draft.provider.update(PROVIDER_ID, (provider: AnyRecord) => {
          provider.name = PROVIDER_NAME;
          provider.package = PROVIDER_PACKAGE;
          const settings = { ...((provider.settings ?? {}) as Record<string, unknown>) } as AnyRecord;
          if (key) {
            settings.apiKey = key;
          } else {
            delete settings.apiKey;
          }
          settings.baseURL = baseURL;
          provider.settings = settings;
        });
        try {
          const rec = draft.provider.list().find((r: AnyRecord) => r.provider?.id === PROVIDER_ID);
          const stored = rec?.models;
          const storedIds: string[] =
            stored instanceof Map ? [...stored.keys()] : Object.keys(stored ?? {});
          for (const id of storedIds) {
            if (!wanted.has(id)) {
              try {
                draft.model.remove(PROVIDER_ID, id);
              } catch {
                continue;
              }
            }
          }
        } catch {
          return;
        }
        for (const model of models) {
          draft.model.update(PROVIDER_ID, model.id, (target: AnyRecord) => {
            Object.assign(target, model);
            delete target.display;
          });
        }
      });
      await ctx.catalog.reload().catch(() => undefined);
    }

    async function sync(reason: string, force: boolean): Promise<void> {
      if (disposed) return;
      const startedAt = Date.now();
      const key = await getActiveKey(ctx);
      if (disposed) return;
      if (!force && key === syncedKey) {
        trace(`sync reason=${reason} key=${shortHash(key)} noop already-synced`);
        return;
      }

      if (key !== syncedKey) {
        // The key changed: never leave the previous key's models selectable.
        // Show this key's last-known list instantly when we have one,
        // otherwise wipe to empty while the fresh discovery runs.
        const cached = key ? perKeyModels.get(keyFingerprint(key)) : undefined;
        trace(`sync reason=${reason} key=${shortHash(key)} changed instant=${cached ? `${cached.length}-cached` : "wipe"}`);
        await writeCatalog(key, cached ?? []);
        if (disposed) return;
        // syncedKey stays untouched until the fetch below succeeds: a failed
        // fetch keeps retrying on the next trigger instead of looking "done".
      } else {
        trace(`sync reason=${reason} key=${shortHash(key)} force-refresh`);
      }

      if (!key) {
        syncedKey = key;
        return;
      }

      const ctrl = new AbortController();
      flight = ctrl;
      let live: GatewayModel[];
      try {
        live = await fetchGatewayModels(baseURL, key, 3, ctrl.signal);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          trace(`sync reason=${reason} key=${shortHash(key)} superseded`);
          return;
        }
        if (isAuthError(err)) {
          // Rejected key: record the empty list so its (lack of) models is
          // honest and the poll fast-path stops hammering the gateway.
          trace(`sync reason=${reason} key=${shortHash(key)} auth-rejected`);
          await writeCatalog(key, []);
          syncedKey = key;
          return;
        }
        // Transient network failure: keep whatever the instant step wrote
        // (cached or empty) and retry on the next trigger.
        trace(`sync reason=${reason} key=${shortHash(key)} fetch-failed ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`);
        return;
      } finally {
        if (flight === ctrl) flight = null;
      }
      if (disposed) return;

      // The fetch took a while: if the user switched again mid-flight,
      // this result belongs to a key that is no longer active — drop it.
      // The trigger for the newer key already queued its own sync.
      const current = await getActiveKey(ctx);
      if (disposed) return;
      if (current !== key) {
        trace(`sync reason=${reason} key=${shortHash(key)} discarded key-moved`);
        return;
      }

      const models = buildModels(live);
      remember(key, models);
      await writeCatalog(key, models);
      syncedKey = key;
      trace(`sync reason=${reason} key=${shortHash(key)} done n=${models.length} ms=${Date.now() - startedAt}`);
      await purgeLegacyFileCache();
    }

    async function pump(): Promise<void> {
      for (;;) {
        const job = wanted;
        wanted = null;
        if (!job || disposed) break;
        try {
          await sync(job.reason, job.force);
        } catch {
          // One bad run must never kill the pump.
        }
      }
    }

    function schedule(reason: string, force = false, preempt = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (preempt) flight?.abort();
      wanted = {
        reason,
        force: (wanted?.force || force) ?? force,
      };
      if (!worker) {
        worker = pump().finally(() => {
          worker = null;
        });
      }
      return worker;
    }

    // Startup: populate before the first `/models` call.
    await schedule("startup", true);

    const pollTimer = setInterval(() => {
      void schedule("poll", false);
    }, POLL_MS);
    if (typeof (pollTimer as unknown as { unref?: () => void }).unref === "function") {
      (pollTimer as unknown as { unref: () => void }).unref();
    }

    const hourlyTimer = setInterval(() => {
      void schedule("hourly", true);
    }, HOURLY_MS);
    if (typeof (hourlyTimer as unknown as { unref?: () => void }).unref === "function") {
      (hourlyTimer as unknown as { unref: () => void }).unref();
    }

    // Account events: run the same sync immediately (preempting any stale
    // in-flight fetch). The key is always re-resolved inside sync, and burst
    // duplicates collapse on the `syncedKey` fast-path — no debounce needed.
    // The loop resubscribes with backoff: a dropped event stream must never
    // silently leave the plugin deaf (the poll would be the only trigger).
    const eventController = new AbortController();
    void (async () => {
      let backoffMs = 500;
      while (!disposed) {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
            if (disposed) return;
            backoffMs = 500;
            const type = event?.type as string | undefined;
            if (type !== "integration.connection.updated" && type !== "integration.updated") continue;
            if (type === "integration.connection.updated") {
              const updatedID = (event.data as AnyRecord | undefined)?.integrationID
                ?? (event.properties as AnyRecord | undefined)?.integrationID;
              if (updatedID && updatedID !== PROVIDER_ID) continue;
            }
            trace(`event type=${type}`);
            void schedule("event", false, true);
          }
          return;
        } catch {
          if (disposed || eventController.signal.aborted) return;
          trace(`event-loop broken, resubscribe in ${backoffMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 10_000);
        }
      }
    })();

    await ctx.aisdk.hook("sdk", async (event: AnyRecord) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      // Requests always authenticate as the *currently selected* account,
      // even if the catalog list is still catching up to a fresh switch.
      const key = await getActiveKey(ctx);
      if (!key) return;
      if (key !== syncedKey) {
        const wait = schedule("sdk", false, true);
        await Promise.race([
          wait,
          new Promise((resolve) => setTimeout(resolve, SDK_WAIT_MS)),
        ]);
      }
      event.options = { ...(event.options ?? {}), apiKey: key, baseURL };
    });

    return () => {
      disposed = true;
      eventController.abort();
      flight?.abort();
      clearInterval(pollTimer);
      clearInterval(hourlyTimer);
    };
  },
};

export default plugin;
