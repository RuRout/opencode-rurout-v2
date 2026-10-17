import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import after setting HOME so no test touches a real installation's cache.
const home = await mkdtemp(join(tmpdir(), "rurout-v2-cache-test-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { MODEL_CACHE_DIR, keyFingerprint, readModelCache, writeModelCache, removeModelCache } = await import("../dist/cache.js");
after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

test("persisted cache is scoped by key and endpoint configuration", async () => {
  const scope = JSON.stringify(["https://gateway-a.invalid/v1"]);
  const other = JSON.stringify(["https://gateway-b.invalid/v1"]);
  const models = [{ id: "new", limit: { context: 98765 }, cost: [{ input: 0 }] }];
  await writeModelCache("test-key-a", scope, models);
  assert.deepEqual(await readModelCache("test-key-a", scope), models);
  assert.equal(await readModelCache("test-key-b", scope), undefined);
  assert.equal(await readModelCache("test-key-a", other), undefined);
  const raw = await readFile(join(MODEL_CACHE_DIR, `v2-models-${keyFingerprint("test-key-a", scope)}.json`), "utf8");
  assert.equal(JSON.parse(raw).version, 2);
  assert.equal(raw.includes("test-key-a"), false);
  await removeModelCache("test-key-a", scope);
  assert.equal(await readModelCache("test-key-a", scope), undefined);
});

test("version 1 guessed model metadata is never loaded", async () => {
  const scope = "old-cache";
  await mkdir(MODEL_CACHE_DIR, { recursive: true });
  const path = join(MODEL_CACHE_DIR, `v2-models-${keyFingerprint("test-key-old", scope)}.json`);
  await writeFile(path, JSON.stringify({ version: 1, models: [{ id: "fabricated-base-id" }] }));
  assert.equal(await readModelCache("test-key-old", scope), undefined);
});
