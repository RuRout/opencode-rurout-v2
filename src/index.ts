import type { Plugin } from "@opencode/plugin";
import {
  DEFAULT_BASE_URLS,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
} from "./constants.js";
import { fetchGatewayModelsFrom, isAuthError, type GatewayModel } from "./discovery.js";
import {
  keyFingerprint,
  purgeLegacyFileCache,
  readModelCache,
  removeModelCache,
  writeModelCache,
} from "./cache.js";
import { buildModels } from "./model-adapter.js";
import { appendFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RuroutOptions {
  baseURL?: string;
}

type AnyRecord = Record<string, any>;

/**
 * An explicit address (plugin option or RUROUT_BASE_URL) is used as-is, with
 * no failover. Without one, the default domains are tried in order.
 */
function baseURLsFrom(opts: RuroutOptions): string[] {
  const explicit = opts.baseURL ?? process.env.RUROUT_BASE_URL;
  if (explicit) return [explicit.replace(/\/$/, "")];
  return DEFAULT_BASE_URLS;
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
 * Keys pasted into /connect or exported in a shell often carry a trailing
 * newline or space. Normalize once so requests, the per-key model cache hash
 * and key-change detection all see the same value.
 */
function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim();
}

function envKey(name?: string): string {
  return (name ? normalizeKey(process.env[name]) : "") || normalizeKey(process.env.RUROUT_API_KEY);
}

/**
 * Single source of truth for "which key is active right now".
 * Always resolved fresh — never trusted from event payloads (the
 * connection events only carry `{ integrationID }`, no key material),
 * so every sync path observes the same state.
 */
async function getActive(ctx: Plugin.Context): Promise<{
  key: string;
  connection: AnyRecord | undefined;
}> {
  try {
    const connection = (await ctx.integration.connection.active(
      PROVIDER_ID,
    )) as AnyRecord | undefined;
    if (!connection) return { key: envKey(), connection: undefined };
    if (connection.type === "env" && typeof connection.name === "string") {
      return { key: envKey(connection.name), connection };
    }
    const credential = (await ctx.integration.connection.resolve(
      connection as never,
    )) as AnyRecord | undefined;
    return {
      key: normalizeKey(credentialKey(credential)) || envKey(),
      connection,
    };
  } catch {
    return { key: envKey(), connection: undefined };
  }
}

async function getActiveKey(ctx: Plugin.Context): Promise<string> {
  return (await getActive(ctx)).key;
}

// ─── Single-path key sync ────────────────────────────────────────────────────
// One rule for every trigger (startup, account event, poll, hourly, pre-request):
//   key selected → models rebuilt from scratch for THAT key, atomically.
//
// Previous generations of this file had four overlapping paths (event hint key,
// 5s poll with its own compare, hourly with clearFirst, sdk-hook settle loop)
// that could interleave: a slow fetch for key A would overwrite a fresh list
// for key B, and the model list kept showing the old key's models for seconds
// after a switch. Now there is exactly one `sync()` and one serial queue.
// Stale results are discarded by re-resolving the active key after the fetch.
//
// V2 note: provider inventory lives in the provider registry
// (`ctx.provider.transform` + `ctx.provider.reload()`). The transform below
// replays from the captured `source` snapshot, so every publish is a single
// atomic `reload()` — no manual model-by-model diff.

const POLL_MS = 5_000;
const HOURLY_MS = 60 * 60 * 1000;
const SDK_WAIT_MS = 30_000;
// Startup without any cached list for the key waits this long for the gateway
// before letting OpenCode finish booting; the sync keeps running after that.
const STARTUP_WAIT_MS = 8_000;
const PER_KEY_CACHE_LIMIT = 20;
const TRACE_PATH = join(tmpdir(), "rurout-sync.log");
const TRACE_MAX_BYTES = 200_000;

// Append-only debug trace (no key material, key hashes or remote error text). Proves which sync
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

// Last-known-good models per key + endpoint scope hash, shared by every plugin instance in this
// process (OpenCode boots one instance per location/directory). Lets a fresh
// location or a repeated account switch render instantly from memory.
// Model ids are not secrets; keyed by hash so raw keys never linger here.
const perKeyModels = new Map<string, AnyRecord[]>();

function remember(key: string, scope: string, models: AnyRecord[]): void {
  const hash = keyFingerprint(key, scope);
  perKeyModels.delete(hash);
  perKeyModels.set(hash, models);
  while (perKeyModels.size > PER_KEY_CACHE_LIMIT) {
    const oldest = perKeyModels.keys().next();
    if (oldest.done) break;
    perKeyModels.delete(oldest.value);
  }
}

function forget(key: string, scope: string): void {
  perKeyModels.delete(keyFingerprint(key, scope));
  void removeModelCache(key, scope);
}

async function cachedModels(key: string, scope: string): Promise<AnyRecord[] | undefined> {
  if (!key) return undefined;
  const memory = perKeyModels.get(keyFingerprint(key, scope));
  if (memory) return memory;
  const disk = await readModelCache<AnyRecord>(key, scope);
  if (disk && disk.length > 0) {
    remember(key, scope, disk);
    return disk;
  }
  return undefined;
}

function sameConnection(a: AnyRecord | undefined, b: AnyRecord | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "env") return a.name === b.name;
  return a.id !== undefined && a.id === b.id;
}

const plugin = {
  id: "rurout",
  setup: async (ctx: Plugin.Context) => {
    const opts = ((ctx as AnyRecord).options ?? {}) as RuroutOptions;
    const baseURLs = baseURLsFrom(opts);
    const cacheScope = JSON.stringify(baseURLs);
    // Switches to whichever address answered the last discovery, so chat and
    // image requests use the same domain that is known to be reachable.
    let baseURL = baseURLs[0];

    let disposed = false;

    // Captured provider snapshot. The provider transform below replays from
    // this on every reload — mutate, then `publish()` (reload).
    const source: {
      info: AnyRecord;
      models: AnyRecord[];
      connection: AnyRecord | undefined;
    } = {
      info: {
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        activation: "enabled",
        package: PROVIDER_PACKAGE,
        integrationID: PROVIDER_ID,
        settings: { baseURL },
      },
      models: [],
      connection: undefined,
    };

    function applySource(key: string, connection: AnyRecord | undefined, models: AnyRecord[]): void {
      source.models = models;
      // Env credentials are global, not a selectable account — don't bind
      // the inventory to them, or the provider could look unavailable.
      source.connection = connection?.type === "env" ? undefined : connection;
      const settings: AnyRecord = { ...(source.info.settings ?? {}), baseURL };
      if (key) {
        settings.apiKey = key;
      } else {
        delete settings.apiKey;
      }
      source.info.settings = settings;
    }

    async function publish(): Promise<void> {
      if (disposed) return;
      await ctx.provider.reload().catch(() => undefined);
    }

    // OpenCode disables the whole plugin if a transform callback throws, so
    // every callback is guarded: a bad edit must degrade, never unload us.
    await ctx.integration.transform((draft: any) => {
      try {
        draft.update(PROVIDER_ID, (ref: AnyRecord) => {
          ref.name = PROVIDER_NAME;
        });
        draft.method.update({
          integrationID: PROVIDER_ID,
          method: { type: "key", label: "API Key" },
        });
      } catch {
        trace("integration transform failed");
      }
    });

    await ctx.provider.transform((editor: any) => {
      try {
        applyProvider(editor);
      } catch {
        trace("provider transform failed");
      }
    });

    function applyProvider(editor: any): void {
      const rec = editor.get(PROVIDER_ID);
      if (rec && sameConnection(rec.sourceConnection, source.connection)) {
        editor.update(PROVIDER_ID, (provider: AnyRecord) => {
          provider.name = PROVIDER_NAME;
          provider.package = PROVIDER_PACKAGE;
          provider.activation = "enabled";
          provider.integrationID = PROVIDER_ID;
          provider.settings = { ...source.info.settings };
        });
        editor.models.set(PROVIDER_ID, [...source.models]);
        return;
      }
      // New provider, or the account behind the inventory changed: replace
      // atomically so the old account's models are never selectable.
      if (rec) editor.remove(PROVIDER_ID);
      editor.add({
        info: { ...source.info, settings: { ...source.info.settings } },
        models: [...source.models],
        ...(source.connection ? { sourceConnection: source.connection } : {}),
      });
    }

    if (ctx.tool?.transform) {
      try {
        await ctx.tool.transform((editor: any) => {
          try {
            addImageTool(editor);
          } catch {
            trace("tool transform failed");
          }
        });
      } catch {
        trace("failed to register generate_image tool");
      }
    }

    function addImageTool(editor: any): void {
      editor.add({
        name: "generate_image",
        description: "Generate or edit an image using RuRout/Sub2API gateway (supports GPT-Image, Gemini Imagen, DALL-E, etc.) and save it locally.",
        input: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Text description of the image to generate.",
            },
            model: {
              type: "string",
              description: "Image generation model to use. Defaults to 'gpt-image-2'. Options: 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-1', 'gemini-3-pro-image', 'dall-e-3'.",
            },
            size: {
              type: "string",
              description: "Image size, e.g. '1024x1024', '1536x1024', '1024x1536'. Defaults to '1024x1024'.",
            },
            quality: {
              type: "string",
              description: "Image quality: 'standard', 'hd', 'high', 'auto'. Defaults to 'auto'.",
            },
            output_path: {
              type: "string",
              description: "Relative or absolute file path to save the generated image (e.g. 'generated_image.png').",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        async execute(inputArgs: any) {
          const activeKey = await getActiveKey(ctx);
          if (!activeKey) {
            return {
              content: "Error: No active RuRout API key configured. Connect RuRout first with /connect.",
            };
          }
          const model = inputArgs.model || "gpt-image-2";
          const size = inputArgs.size || "1024x1024";
          const quality = inputArgs.quality || "auto";
          const prompt = inputArgs.prompt;
          const outputPath = inputArgs.output_path || `image_${Date.now()}.png`;

          const endpoint = baseURL.endsWith("/v1")
            ? `${baseURL}/images/generations`
            : `${baseURL}/v1/images/generations`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${activeKey}`,
            },
            body: JSON.stringify({
              model,
              prompt,
              size,
              quality,
              response_format: "b64_json",
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            return {
              content: `Image generation failed (${res.status}): ${errText}`,
            };
          }

          const data = (await res.json()) as any;
          const imgItem = data?.data?.[0];
          if (!imgItem) {
            return {
              content: `Image generation succeeded but no image data returned: ${JSON.stringify(data)}`,
            };
          }

          if (imgItem.b64_json) {
            const buffer = Buffer.from(imgItem.b64_json, "base64");
            await writeFile(outputPath, buffer);
            return {
              content: `Image successfully generated and saved to ${outputPath} (Model: ${model}, Size: ${size})`,
            };
          } else if (imgItem.url) {
            // Fetch image from URL and save locally
            const imgRes = await fetch(imgItem.url);
            if (imgRes.ok) {
              const arrBuf = await imgRes.arrayBuffer();
              await writeFile(outputPath, Buffer.from(arrBuf));
              return {
                content: `Image successfully generated from ${imgItem.url} and saved to ${outputPath} (Model: ${model}, Size: ${size})`,
              };
            }
            return {
              content: `Image successfully generated. URL: ${imgItem.url} (Failed to download locally: ${imgRes.statusText})`,
            };
          }

          return {
            content: `Image generation response received: ${JSON.stringify(imgItem)}`,
          };
        },
      });
    }

    await purgeLegacyFileCache();

    // Last key fully written to the registry (with its own models, or an empty
    // list for a rejected key). `undefined` = never synced since startup.
    let syncedKey: string | undefined;
    // A failed refresh of an already-synced key must remain due: otherwise
    // the 5s poll's fast-path would postpone retries until the next hour.
    let refreshNeeded = false;
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
    // Key the in-flight fetch belongs to. Preemption only aborts a fetch for a
    // key that is no longer active — aborting a fetch for the *same* key just
    // restarts it, and our own reload() emits provider events, so an
    // unconditional abort would loop forever and never finish a sync.
    let flightKey: string | undefined;

    async function sync(reason: string, force: boolean): Promise<void> {
      if (disposed) return;
      const startedAt = Date.now();
      const { key, connection } = await getActive(ctx);
      if (disposed) return;
      if (!force && !refreshNeeded && key === syncedKey) {
        trace(`sync reason=${reason} noop already-synced`);
        return;
      }

      if (key !== syncedKey) {
        // The key changed: never leave the previous key's models selectable.
        // Show this key's last-known list instantly when we have one,
        // otherwise wipe to empty while the fresh discovery runs.
        const cached = await cachedModels(key, cacheScope);
        if (disposed) return;
        trace(`sync reason=${reason} changed instant=${cached ? `${cached.length}-cached` : "wipe"}`);
        applySource(key, connection, cached ?? []);
        await publish();
        if (disposed) return;
        // syncedKey stays untouched until the fetch below succeeds: a failed
        // fetch keeps retrying on the next trigger instead of looking "done".
      } else {
        trace(`sync reason=${reason} force-refresh`);
      }

      if (!key) {
        syncedKey = key;
        refreshNeeded = false;
        return;
      }

      const ctrl = new AbortController();
      flight = ctrl;
      flightKey = key;
      let live: GatewayModel[];
      let reachable: string;
      try {
        ({ baseURL: reachable, models: live } = await fetchGatewayModelsFrom(baseURLs, key, ctrl.signal));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          trace(`sync reason=${reason} superseded`);
          return;
        }
        // A late rejection for the old account must not clear a new account's
        // inventory (or republish a disposed plugin).
        const current = await getActive(ctx);
        if (disposed || current.key !== key) return;
        if (isAuthError(err)) {
          // Rejected key: record the empty list so its (lack of) models is
          // honest and the poll fast-path stops hammering the gateway.
          trace(`sync reason=${reason} auth-rejected`);
          forget(key, cacheScope);
          applySource(key, current.connection, []);
          await publish();
          syncedKey = key;
          refreshNeeded = false;
          return;
        }
        // Transient network failure: keep whatever the instant step wrote
        // (cached or empty) and retry on the next trigger.
        refreshNeeded = true;
        trace(`sync reason=${reason} fetch-failed`);
        return;
      } finally {
        if (flight === ctrl) {
          flight = null;
          flightKey = undefined;
        }
      }
      if (disposed) return;

      // The fetch took a while: if the user switched again mid-flight,
      // this result belongs to a key that is no longer active — drop it.
      // The trigger for the newer key already queued its own sync.
      const current = await getActive(ctx);
      if (disposed) return;
      if (current.key !== key) {
        trace(`sync reason=${reason} discarded key-moved`);
        return;
      }

      if (reachable !== baseURL) trace("gateway address switched");
      baseURL = reachable;
      const models = buildModels(live);
      remember(key, cacheScope, models);
      void writeModelCache(key, cacheScope, models);
      applySource(key, current.connection, models);
      await publish();
      syncedKey = key;
      refreshNeeded = false;
      trace(`sync reason=${reason} done n=${models.length} ms=${Date.now() - startedAt}`);
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

    async function preemptStale(): Promise<void> {
      const pending = flight;
      if (!pending) return;
      const key = await getActiveKey(ctx);
      if (flight === pending && flightKey !== key) pending.abort();
    }

    function schedule(reason: string, force = false, preempt = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (preempt) void preemptStale();
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

    // Requests always authenticate as the *currently selected* account,
    // even if the registry list is still catching up to a fresh switch.
    async function injectAuth(event: AnyRecord): Promise<void> {
      if (event.model?.providerID !== PROVIDER_ID) return;
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
    }

    // Startup: never block OpenCode on the network. A cached list for the
    // active key is published by the instant step right away and refreshed
    // in the background; only a key with no cache at all waits (bounded) so
    // the very first `/models` call is not empty.
    const startup = schedule("startup", true);
    const startKey = await getActiveKey(ctx);
    if (!(await cachedModels(startKey, cacheScope))) {
      await Promise.race([
        startup,
        new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS)),
      ]);
    }

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
    // duplicates coalesce in the queue. Explicit events also refresh metadata
    // for the same key, without requiring a restart or waiting for the hour.
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
            const type = (event as AnyRecord)?.type as string | undefined;
            // provider.updated / model.updated are echoes of our own reload();
            // account switches arrive as integration/connection/credential events.
            if (!type || !/integration|credential|connection|auth/i.test(type)) continue;
            const updatedID = (event as AnyRecord).data?.integrationID
              ?? (event as AnyRecord).properties?.integrationID;
            if (updatedID && updatedID !== PROVIDER_ID) continue;
            trace("account event");
            void schedule("event", true, true);
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

    await ctx.aisdk.hook("sdk", injectAuth, { providerID: PROVIDER_ID });
    await ctx.aisdk.hook("language", injectAuth, { providerID: PROVIDER_ID });

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
