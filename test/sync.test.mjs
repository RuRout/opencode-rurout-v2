import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";

const home = await mkdtemp(join(tmpdir(), "rurout-v2-sync-test-"));
const previousHome = process.env.HOME;
const previousTmp = process.env.TMPDIR;
process.env.HOME = home;
process.env.TMPDIR = home;
const { default: plugin } = await import("../dist/index.js");
const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
let timers;
let cleanup;

beforeEach(() => {
  timers = new Map();
  globalThis.setInterval = (callback, ms) => {
    timers.set(ms, callback);
    return ms;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  // Discovery retries stay deterministic/fast; startup/request deadlines are
  // unref'd so successful tests do not leave an 8s/30s process wait behind.
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = realSetTimeout(callback, ms <= 900 ? 0 : ms, ...args);
    timer.unref();
    return timer;
  };
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.setTimeout = realSetTimeout;
});

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(home, { recursive: true, force: true });
});

async function until(predicate) {
  for (let i = 0; i < 10000; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("sync did not reach the expected state");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(key, baseURL = "https://sync.invalid/v1") {
  let activeKey = key;
  let pending;
  const queued = [];
  let provider;
  let transform;
  const snapshots = [];
  const editor = {
    get: () => provider,
    remove: () => { provider = undefined; },
    add: (entry) => { provider = { provider: entry.info, sourceConnection: entry.sourceConnection, models: entry.models }; },
    update: (_id, update) => update(provider.provider),
    models: { set: (_id, models) => { provider.models = models; } },
  };
  const ctx = {
    options: baseURL === null ? {} : { baseURL },
    integration: {
      transform: async () => {},
      connection: {
        active: async () => ({ type: "key", id: activeKey }),
        resolve: async (connection) => ({ type: "key", key: connection.id }),
      },
    },
    provider: {
      transform: async (callback) => { transform = callback; transform(editor); },
      reload: async () => {
        transform(editor);
        snapshots.push(structuredClone(provider));
      },
    },
    aisdk: { hook: async () => {} },
    event: {
      subscribe: ({ signal }) => {
        signal.addEventListener("abort", () => pending?.({ done: true }), { once: true });
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (signal.aborted) return Promise.resolve({ done: true });
            if (queued.length) return Promise.resolve({ done: false, value: queued.shift() });
            return new Promise((resolve) => { pending = resolve; });
          },
        };
      },
    },
  };
  return {
    ctx, snapshots,
    current: () => provider,
    key: (next) => { activeKey = next; },
    emit: () => {
      const event = { type: "integration.connection.updated", data: { integrationID: "rurout" } };
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ done: false, value: event });
      } else queued.push(event);
    },
  };
}

const ok = (entry) => new Response(JSON.stringify({ data: [entry] }));

test("same-key connection events and hourly refresh republish changed prices and limits", async () => {
  const h = harness("refresh-test-key");
  let entry = { id: "brand-new", context_window: 1000, pricing: { currency: "USD", unit: "per_token", input_price: 0.000002 } };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok(entry); };
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.limit.context === 1000);
  entry = { ...entry, context_window: 2000, pricing: { ...entry.pricing, input_price: 0 } };
  h.emit();
  await until(() => h.current().models[0]?.limit.context === 2000);
  assert.equal(h.current().models[0].cost[0].input, 0);
  entry = { ...entry, context_window: 3000, pricing: { ...entry.pricing, input_price: 0.000004 } };
  timers.get(3600000)();
  await until(() => h.current().models[0]?.limit.context === 3000);
  assert.equal(h.current().models[0].cost[0].input, 4);
  assert.equal(calls, 3);
});

test("failed hourly refresh stays due for the safety poll and keeps last-known metadata", async () => {
  const h = harness("retry-test-key");
  let fail = false;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return fail ? new Response("{}", { status: 503 }) : ok({ id: "retry-model", context_window: calls === 1 ? 1000 : 5000 });
  };
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.limit.context === 1000);
  fail = true;
  timers.get(3600000)();
  await until(() => calls === 4); // initial success + three failed discovery attempts
  // Queue the poll even if the last retry's delay has not completed yet.
  assert.equal(h.current().models[0].limit.context, 1000);
  fail = false;
  timers.get(5000)();
  await until(() => h.current().models[0]?.limit.context === 5000);
  assert.equal(calls, 5);
});

test("late auth rejection from an old key is discarded, then the new key wins", async () => {
  const h = harness("old-auth-test-key");
  const late = deferred();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (calls === 2) return late.promise; // intentionally ignores abort to model a late response
    const key = options.headers.Authorization;
    return ok({ id: key.endsWith("old-auth-test-key") ? "old-model" : "new-model" });
  };
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.id === "old-model");
  h.emit();
  await until(() => calls === 2);
  const beforeRejection = h.snapshots.length;
  h.key("new-auth-test-key");
  late.resolve(new Response("{}", { status: 401 }));
  // A later hourly trigger is queued behind the old result. The only publish
  // before the new-key wipe must still be the old-key successful inventory.
  timers.get(3600000)();
  await until(() => h.current().models[0]?.id === "new-model");
  const after = h.snapshots.slice(beforeRejection);
  assert.ok(after.length >= 2);
  assert.ok(after.every((s) => s.provider.settings.apiKey === "new-auth-test-key"));
});

test("late successful discovery cannot republish the previous key's models", async () => {
  const h = harness("old-success-test-key");
  const late = deferred();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) return late.promise;
    return ok({ id: calls === 1 ? "initial-old-model" : "selected-new-model" });
  };
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.id === "initial-old-model");
  h.emit();
  await until(() => calls === 2);
  const before = h.snapshots.length;
  h.key("new-success-test-key");
  h.emit();
  late.resolve(ok({ id: "stale-success-model" }));
  await until(() => h.current().models[0]?.id === "selected-new-model");
  assert.ok(h.snapshots.slice(before).every((s) => s.models.every((m) => m.id !== "stale-success-model")));
  assert.equal(h.current().provider.settings.apiKey, "new-success-test-key");
});

test("bursty connection events coalesce and never run concurrent discovery", async () => {
  const h = harness("singleflight-test-key");
  const gate = deferred();
  let calls = 0;
  let running = 0;
  let maxRunning = 0;
  globalThis.fetch = async () => {
    const call = ++calls;
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (call === 2) await gate.promise;
      return ok({ id: "single-model", context_window: call });
    } finally {
      running--;
    }
  };
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.limit.context === 1);
  h.emit();
  await until(() => calls === 2);
  for (let i = 0; i < 20; i++) h.emit();
  // Let every queued event reach schedule while discovery is still blocked.
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(calls, 2);
  gate.resolve();
  await until(() => h.current().models[0]?.limit.context === 3);
  assert.equal(maxRunning, 1);
  assert.equal(calls, 3);
});

test("shared in-memory inventory is isolated by both endpoint and key", async () => {
  const first = harness("shared-scope-test-key", "https://first.invalid/v1");
  const second = harness("shared-scope-test-key", "https://second.invalid/v1");
  const third = harness("other-scope-test-key", "https://first.invalid/v1");
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? ok({ id: "first-private-model" }) : pending.promise;
  };
  const stopFirst = await plugin.setup(first.ctx);
  cleanup = stopFirst;
  await until(() => first.current().models[0]?.id === "first-private-model");
  const startingSecond = plugin.setup(second.ctx);
  await until(() => calls === 2);
  assert.deepEqual(second.current().models, []);
  pending.resolve(ok({ id: "second-private-model" }));
  const stopSecond = await startingSecond;
  cleanup = () => { stopFirst(); stopSecond(); };
  assert.equal(second.current().models[0].id, "second-private-model");
  const thirdPending = deferred();
  globalThis.fetch = async () => { calls++; return thirdPending.promise; };
  const startingThird = plugin.setup(third.ctx);
  await until(() => calls === 3);
  assert.deepEqual(third.current().models, []);
  thirdPending.resolve(ok({ id: "third-private-model" }));
  const stopThird = await startingThird;
  cleanup = () => { stopFirst(); stopSecond(); stopThird(); };
  assert.equal(third.current().models[0].id, "third-private-model");
});

// --- mid-session domain failover (default domain list, no explicit baseURL) ---

const PROBE_MS = 30_000;
const COM = "rurout.com";
const RU = "rurout.ru";
const ONLINE = "rurout.online";

// Per-host gateway behaviour: "up" answers, "down" is a network failure, a
// number is an HTTP status, a deferred holds the request open.
function gateway(hosts) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).host;
    calls.push(host);
    const mode = hosts[host];
    if (mode === "down") throw new TypeError("fetch failed");
    if (typeof mode === "number") return new Response("{}", { status: mode });
    if (mode && typeof mode.then === "function") {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        mode.then(resolve);
      });
    }
    return ok({ id: "m" });
  };
  return calls;
}

const publishedBase = (h) => h.current().provider.settings.baseURL;

async function started(hosts) {
  const h = harness("failover-test-key", null);
  const calls = gateway(hosts);
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.id === "m");
  assert.equal(publishedBase(h), `https://${COM}/v1`);
  // The startup sync keeps its worker busy a little after publishing (cache
  // housekeeping); the monitor skips ticks meanwhile. Run healthy probe
  // ticks until one actually executes, so tests start from an idle plugin.
  for (let i = 0; ; i++) {
    assert.ok(i < 2000, "plugin never became idle");
    const seen = calls.length;
    await timers.get(PROBE_MS)();
    if (calls.length > seen) break;
    await tick();
  }
  return { h, calls, hosts };
}

test("active domain going down mid-session republishes the next reachable domain", async () => {
  const { h, hosts } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  const before = h.snapshots.length;
  hosts[COM] = "down";
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${RU}/v1`);
  assert.equal(h.snapshots.length, before + 1);
  assert.equal(h.current().provider.settings.apiKey, "failover-test-key");
  assert.equal(h.current().models[0].id, "m");
  hosts[RU] = "down";
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${ONLINE}/v1`);
});

test("a healthy active domain is probed without republishing", async () => {
  const { h } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  const before = h.snapshots.length;
  await timers.get(PROBE_MS)();
  await timers.get(PROBE_MS)();
  assert.equal(h.snapshots.length, before);
});

test("returns to the primary domain only after consecutive successful probes", async () => {
  const { h, hosts } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  hosts[COM] = "down";
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${RU}/v1`);
  hosts[COM] = "up";
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${RU}/v1`);
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${COM}/v1`);
});

test("a flapping primary domain does not make the address bounce", async () => {
  const { h, hosts } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  hosts[COM] = "down";
  await timers.get(PROBE_MS)();
  const before = h.snapshots.length;
  for (const state of ["up", "down", "up", "down"]) {
    hosts[COM] = state;
    await timers.get(PROBE_MS)();
  }
  assert.equal(publishedBase(h), `https://${RU}/v1`);
  assert.equal(h.snapshots.length, before);
  hosts[COM] = "up";
  await timers.get(PROBE_MS)();
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${COM}/v1`);
});

test("HTTP error statuses mean the domain is reachable and never trigger a switch", async () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503]) {
    const { h, hosts, calls } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
    const before = h.snapshots.length;
    hosts[COM] = status;
    const probed = calls.length;
    await timers.get(PROBE_MS)();
    assert.equal(publishedBase(h), `https://${COM}/v1`, `status ${status}`);
    assert.equal(h.snapshots.length, before, `status ${status}`);
    assert.deepEqual(calls.slice(probed), [COM], `status ${status}: only the active domain is probed`);
    cleanup();
    cleanup = undefined;
  }
});

test("all domains unreachable keeps the current address and does not republish", async () => {
  const { h, hosts } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  const before = h.snapshots.length;
  hosts[COM] = hosts[RU] = hosts[ONLINE] = "down";
  await timers.get(PROBE_MS)();
  await timers.get(PROBE_MS)();
  assert.equal(publishedBase(h), `https://${COM}/v1`);
  assert.equal(h.snapshots.length, before);
});

test("at most one probe cycle is in flight", async () => {
  const { hosts, calls } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  const hold = deferred();
  hosts[COM] = hold.promise;
  const before = calls.length;
  const first = timers.get(PROBE_MS)();
  await until(() => calls.length === before + 1);
  await timers.get(PROBE_MS)();
  await timers.get(PROBE_MS)();
  assert.equal(calls.length, before + 1);
  hold.resolve(new Response("{}", { status: 503 }));
  await first;
  hosts[COM] = "up";
  await timers.get(PROBE_MS)();
  assert.equal(calls.length, before + 2);
});

test("an account change discards the result of a probe made with the old key", async () => {
  const { h, hosts, calls } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  const hold = deferred();
  hosts[COM] = hold.promise;
  const before = calls.length;
  const probing = timers.get(PROBE_MS)();
  await until(() => calls.length === before + 1);
  h.key("failover-other-key");
  h.emit();
  await probing;
  assert.equal(publishedBase(h), `https://${COM}/v1`);
  await until(() => h.current().provider.settings.apiKey === "failover-other-key");
});

test("an explicit baseURL is never monitored or switched", async () => {
  const h = harness("explicit-test-key", "https://explicit.invalid/v1");
  gateway({ "explicit.invalid": "up" });
  cleanup = await plugin.setup(h.ctx);
  await until(() => h.current().models[0]?.id === "m");
  assert.equal(timers.has(PROBE_MS), false);
  const previous = process.env.RUROUT_BASE_URL;
  process.env.RUROUT_BASE_URL = "https://env.invalid/v1";
  try {
    const env = harness("explicit-env-key", null);
    gateway({ "env.invalid": "up" });
    const stop = await plugin.setup(env.ctx);
    const stopBoth = cleanup;
    cleanup = () => { stopBoth(); stop(); };
    await until(() => env.current().models[0]?.id === "m");
    assert.equal(timers.has(PROBE_MS), false);
    assert.equal(publishedBase(env), "https://env.invalid/v1");
  } finally {
    if (previous === undefined) delete process.env.RUROUT_BASE_URL;
    else process.env.RUROUT_BASE_URL = previous;
  }
});

test("unloading stops the probe timer and cancels a probe in flight", async () => {
  const { h, hosts, calls } = await started({ [COM]: "up", [RU]: "up", [ONLINE]: "up" });
  assert.equal(timers.has(PROBE_MS), true);
  const tick = timers.get(PROBE_MS);
  const hold = deferred();
  hosts[COM] = hold.promise;
  const before = calls.length;
  const probing = tick();
  await until(() => calls.length === before + 1);
  const published = h.snapshots.length;
  cleanup();
  cleanup = undefined;
  assert.equal(timers.has(PROBE_MS), false);
  await probing;
  assert.equal(h.snapshots.length, published);
});
