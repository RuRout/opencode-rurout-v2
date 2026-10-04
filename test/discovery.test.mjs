import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchGatewayModelsFrom } from "../dist/discovery.js";

const RU = "https://rurout.ru/v1";
const ONLINE = "https://rurout.online/v1";
const realFetch = globalThis.fetch;

function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const origin = new URL(String(url)).origin;
    const handler = handlers[origin];
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler();
  };
  return calls;
}

const ok = (ids) => () =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
const unreachable = () => {
  throw new TypeError("fetch failed");
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("uses the first address when it answers", async () => {
  const calls = mockFetch({ "https://rurout.ru": ok(["a"]), "https://rurout.online": ok(["b"]) });
  const res = await fetchGatewayModelsFrom([RU, ONLINE], "k");
  assert.equal(res.baseURL, RU);
  assert.deepEqual(res.models.map((m) => m.id), ["a"]);
  assert.deepEqual(calls, [`${RU}/models`]);
});

test("fails over to the next address when the first is unreachable", async () => {
  mockFetch({ "https://rurout.ru": unreachable, "https://rurout.online": ok(["b"]) });
  const res = await fetchGatewayModelsFrom([RU, ONLINE], "k");
  assert.equal(res.baseURL, ONLINE);
  assert.deepEqual(res.models.map((m) => m.id), ["b"]);
});

test("a rejected key is reported, not masked by failover", async () => {
  const calls = mockFetch({
    "https://rurout.ru": () => new Response("{}", { status: 401 }),
    "https://rurout.online": ok(["b"]),
  });
  await assert.rejects(fetchGatewayModelsFrom([RU, ONLINE], "k"), /rejected the API key/);
  assert.deepEqual(calls, [`${RU}/models`]);
});

test("aborts propagate without trying other addresses", async () => {
  const ctrl = new AbortController();
  const calls = mockFetch({ "https://rurout.ru": ok(["a"]), "https://rurout.online": ok(["b"]) });
  ctrl.abort();
  await assert.rejects(fetchGatewayModelsFrom([RU, ONLINE], "k", ctrl.signal), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("reports the last error when every address is unreachable", async () => {
  mockFetch({ "https://rurout.ru": unreachable, "https://rurout.online": unreachable });
  await assert.rejects(fetchGatewayModelsFrom([RU, ONLINE], "k"), /rurout\.online.*fetch failed/);
});
