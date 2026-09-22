import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
} from "./constants.js";
import { fetchGatewayModels } from "./discovery.js";
import { purgeLegacyFileCache } from "./cache.js";
import { displayName, familyOf, isImage, isReasoning, lookup } from "./fallback.js";

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

async function resolveApiKey(ctx: PluginContext): Promise<string> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return process.env.RUROUT_API_KEY ?? "";
    const credential = await ctx.integration.connection.resolve(connection);
    return credentialKey(credential) || process.env.RUROUT_API_KEY || "";
  } catch {
    return process.env.RUROUT_API_KEY ?? "";
  }
}

function toModel(canonical: string, apiId: string, display: string | undefined, providerID: string): AnyRecord {
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
    variants: [],
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

const KEY_WATCH_INTERVAL_MS = 15_000;
const MODEL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

async function applyModels(
  ctx: PluginContext,
  baseURL: string,
  apiKey: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const live = await fetchGatewayModels(baseURL, apiKey);
  if (!isCurrent()) return false;
  const models = [...new Map(live.map((model) => [model.id, model])).values()].map((model) => {
    const result = toModel(model.id, model.id, model.display_name, PROVIDER_ID);
    result.display = model.display_name ?? model.id;
    return result;
  });
  if (!isCurrent()) return false;
  const seen = new Set(models.map((m) => m.id));
  await ctx.catalog.transform((draft: AnyRecord) => {
    if (!isCurrent()) return;
    draft.provider.update(PROVIDER_ID, (provider: AnyRecord) => {
      provider.name = PROVIDER_NAME;
      provider.package = PROVIDER_PACKAGE;
      provider.settings = { ...(provider.settings ?? {}), apiKey, baseURL };
    });
    try {
      const rec = draft.provider.list().find((r: AnyRecord) => r.provider?.id === PROVIDER_ID);
      const stored = rec?.models;
      const storedIds: string[] =
        stored instanceof Map ? [...stored.keys()] : Object.keys(stored ?? {});
      for (const id of storedIds) {
        if (!seen.has(id)) {
          try {
            draft.model.remove(PROVIDER_ID, id);
          } catch {
              // Model may already be gone; ignore per-model errors.
            }
        }
      }
    } catch {
      // Stale cleanup is best-effort; discovery below still applies.
    }
    for (const model of models) {
      draft.model.update(PROVIDER_ID, model.id, (target: AnyRecord) => {
        Object.assign(target, model);
        delete target.display;
      });
    }
  });
  return true;
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

    let lastKey = await resolveApiKey(ctx);
    let refreshVersion = 0;
    const refresh = async (key: string, clearFirst: boolean) => {
      const version = ++refreshVersion;
      if (clearFirst) {
        // Do not leave models from the previous key selectable while discovery runs.
        await ctx.catalog.transform((draft: AnyRecord) => {
          const rec = draft.provider.list().find((r: AnyRecord) => r.provider?.id === PROVIDER_ID);
          const stored = rec?.models;
          const ids = stored instanceof Map ? [...stored.keys()] : Object.keys(stored ?? {});
          for (const id of ids) draft.model.remove(PROVIDER_ID, id);
        });
        await ctx.catalog.reload().catch(() => undefined);
      }
      if (!key) return;
      await purgeLegacyFileCache();
      try {
        const applied = await applyModels(ctx, baseURL, key, () => version === refreshVersion && key === lastKey);
        if (applied) await ctx.catalog.reload().catch(() => undefined);
      } catch {
        // Keep the last successful list for periodic refreshes. A changed key was
        // cleared above, so unavailable models are never carried to the new key.
      }
    };
    if (lastKey) await refresh(lastKey, false);

    const keyWatchTimer = setInterval(() => {
      void (async () => {
        const key = await resolveApiKey(ctx);
        if (key !== lastKey) {
          lastKey = key;
          await refresh(key, true);
        }
      })();
    }, KEY_WATCH_INTERVAL_MS);
    if (typeof (keyWatchTimer as unknown as { unref?: () => void }).unref === "function") {
      (keyWatchTimer as unknown as { unref: () => void }).unref();
    }

    const hourlyRefreshTimer = setInterval(() => {
      void refresh(lastKey, false);
    }, MODEL_REFRESH_INTERVAL_MS);
    if (typeof (hourlyRefreshTimer as unknown as { unref?: () => void }).unref === "function") {
      (hourlyRefreshTimer as unknown as { unref: () => void }).unref();
    }

    const eventController = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (event?.type !== "integration.connection.updated") continue;
          const updatedID = (event.data as AnyRecord | undefined)?.integrationID
            ?? (event.properties as AnyRecord | undefined)?.integrationID;
          if (updatedID && updatedID !== PROVIDER_ID) continue;
          const key = await resolveApiKey(ctx);
          if (key !== lastKey) {
            lastKey = key;
            await refresh(key, true);
          }
        }
      } catch {
        // Aborted on dispose.
      }
    })();

    await ctx.aisdk.hook("sdk", async (event: AnyRecord) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      const key = await resolveApiKey(ctx);
      if (!key) return;
      event.options = { ...(event.options ?? {}), apiKey: key, baseURL };
      const changed = key !== lastKey;
      if (changed) {
        lastKey = key;
      }
      await refresh(key, changed);
    });

    return () => {
      eventController.abort();
      clearInterval(keyWatchTimer);
      clearInterval(hourlyRefreshTimer);
    };
  },
};

export default plugin;
