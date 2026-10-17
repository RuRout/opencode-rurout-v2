import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModels, toModel } from "../dist/model-adapter.js";
import { lookup } from "../dist/fallback.js";

test("arbitrary new API IDs use all supplied metadata and per-token USD prices", () => {
  const model = toModel({
    id: "new_VENDOR/v9-experimental-high",
    display_name: "  EXACT_name-β  (Custom Preview)  ",
    context_window: 987654,
    max_input_tokens: 876543,
    max_output_tokens: 54321,
    reasoning: true,
    supports_tools: true,
    input_modalities: ["text", "image", "audio"],
    output_modalities: ["text", "audio"],
    supported_reasoning_levels: ["minimal", "xhigh"],
    pricing: {
      currency: "USD", unit: "per_token", input_price: 0.000002,
      output_price: 0.000008, cache_read_price: 0.000001, cache_write_price: 0.000003,
    },
  });
  assert.equal(model.id, "new_VENDOR/v9-experimental-high");
  assert.equal(model.modelID, model.id);
  assert.equal(model.name, "EXACT_name-β  (Custom Preview)");
  assert.deepEqual(model.limit, { context: 987654, input: 876543, output: 54321 });
  assert.deepEqual(model.capabilities, { tools: true, input: ["text", "image", "audio"], output: ["text", "audio"] });
  assert.deepEqual(model.variants, [
    { id: "minimal", settings: { reasoningEffort: "minimal" } },
    { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
  ]);
  assert.equal(model.settings.reasoning, true);
  assert.deepEqual(model.cost, [{ input: 2, output: 8, cache: { read: 1, write: 3 } }]);
});

test("partial metadata falls back independently, not as a whole model", () => {
  const fallback = lookup("claude-sonnet-4-6");
  const model = toModel({
    id: "claude-sonnet-4-6", max_input_tokens: 12345, context_window: 77777,
    input_modalities: ["audio"],
    pricing: { currency: "USD", unit: "per_token", output_price: 0.000002 },
  });
  assert.deepEqual(model.limit, { context: 77777, input: 12345, output: fallback.output });
  assert.deepEqual(model.capabilities, { tools: true, input: ["audio"], output: ["text"] });
  assert.deepEqual(model.cost, [{ input: fallback.input, output: 2, cache: { read: fallback.cacheRead, write: 0 } }]);
  assert.equal(model.settings.reasoning, true);
});

test("zero prices, false and empty arrays override inference, but zero limits fall back", () => {
  const model = toModel({
    id: "gpt-6-high", context_window: 0, max_input_tokens: 0, max_output_tokens: 0,
    reasoning: false, supports_tools: false, input_modalities: [], output_modalities: [],
    supported_reasoning_levels: [],
    pricing: { currency: "USD", unit: "per_token", input_price: 0, output_price: 0, cache_read_price: 0, cache_write_price: 0 },
  });
  assert.deepEqual(model.limit, toModel({ id: "gpt-6-high" }).limit);
  assert.equal("input" in model.limit, false);
  assert.deepEqual(model.capabilities, { tools: false, input: [], output: [] });
  assert.equal(model.settings.reasoning, false);
  assert.deepEqual(model.variants, []);
  assert.deepEqual(model.cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
  assert.deepEqual(toModel({ id: "gpt-6-high", reasoning: false }).variants, []);
});

test("pricing requires explicit USD/per_token and never guesses currency or units", () => {
  const expected = toModel({ id: "claude-opus-4-6" }).cost;
  for (const pricing of [
    null, 0, "free", [], {},
    { currency: "EUR", unit: "per_token", input_price: 0 },
    { currency: "usd", unit: "per_token", input_price: 0 },
    { currency: "USD", unit: "per_million_tokens", input_price: 0 },
    { currency: "USD", input_price: 0 },
    { unit: "per_token", input_price: 0 },
  ]) {
    assert.deepEqual(toModel({ id: "claude-opus-4-6", pricing }).cost, expected);
  }
});

test("invalid price value types fall back individually; null is not free", () => {
  const fallback = lookup("claude-opus-4-6");
  for (const value of [null, "0", true, false, -1, NaN, Infinity, {}, [], Number.MAX_VALUE]) {
    const model = toModel({
      id: "claude-opus-4-6",
      pricing: { currency: "USD", unit: "per_token", input_price: value, output_price: 0, cache_read_price: value, cache_write_price: value },
    });
    assert.deepEqual(model.cost, [{ input: fallback.input, output: 0, cache: { read: fallback.cacheRead, write: 0 } }]);
    const outputInvalid = toModel({
      id: "claude-opus-4-6",
      pricing: { currency: "USD", unit: "per_token", input_price: 0, output_price: value, cache_read_price: 0, cache_write_price: 0 },
    });
    assert.deepEqual(outputInvalid.cost, [{ input: 0, output: fallback.outputCost, cache: { read: 0, write: 0 } }]);
  }
});

test("invalid limits, booleans and arrays use only the affected fallback", () => {
  const base = toModel({ id: "gpt-6" });
  for (const value of [null, "123", true, 0, -1, 0.5, Infinity, NaN, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const model = toModel({ id: "gpt-6", context_window: value, max_input_tokens: value, max_output_tokens: value });
    assert.deepEqual(model.limit, base.limit);
    assert.equal("input" in model.limit, false);
  }
  for (const value of [null, "false", 0, {}, ["text", 1], [""]]) {
    const model = toModel({ id: "gpt-6", reasoning: value, supports_tools: value, input_modalities: value, output_modalities: value, supported_reasoning_levels: value });
    assert.deepEqual(model.capabilities, base.capabilities);
    assert.deepEqual(model.settings, base.settings);
    assert.deepEqual(model.variants, base.variants);
  }
});

test("input and output limits cannot exceed the selected context", () => {
  assert.deepEqual(toModel({
    id: "new-model", context_window: 1000, max_input_tokens: 3000, max_output_tokens: 2000,
  }).limit, { context: 1000, input: 1000, output: 1000 });
  assert.deepEqual(toModel({
    id: "new-model", context_window: 1000, max_input_tokens: 500, max_output_tokens: 100,
  }).limit, { context: 1000, input: 500, output: 100 });
  assert.deepEqual(toModel({
    id: "new-model", context_window: 0, max_input_tokens: 300000, max_output_tokens: 400000,
  }).limit, { context: 200000, input: 200000, output: 200000 });
  assert.deepEqual(toModel({ id: "new-model", context_window: 1000 }).limit,
    { context: 1000, output: 1000 });
});

test("modality arrays accept only schema modalities while reasoning levels remain open strings", () => {
  const valid = ["text", "image", "audio", "video", "pdf"];
  const model = toModel({ id: "new-model", input_modalities: valid, output_modalities: valid });
  assert.deepEqual(model.capabilities.input, valid);
  assert.deepEqual(model.capabilities.output, valid);
  const fallback = toModel({ id: "gpt-6" });
  for (const invalid of [["text", "arbitrary"], ["IMAGE"], ["__proto__"], ["constructor"], ["text", null]]) {
    const result = toModel({ id: "gpt-6", input_modalities: invalid, output_modalities: invalid });
    assert.deepEqual(result.capabilities, fallback.capabilities);
  }
  assert.deepEqual(toModel({
    id: "new-model", supported_reasoning_levels: ["vendor-specific"],
  }).variants, [{ id: "vendor-specific", settings: { reasoningEffort: "vendor-specific" } }]);
});

test("explicit reasoning=false wins over conflicting supplied reasoning levels", () => {
  const model = toModel({ id: "gpt-6-high", reasoning: false, supported_reasoning_levels: ["high", "xhigh"] });
  assert.equal(model.settings.reasoning, false);
  assert.deepEqual(model.variants, []);
});

test("prototype-like unknown IDs use safe fallback metadata and remain exact models", () => {
  const defaults = { context: 200000, output: 32000, input: 1, outputCost: 5 };
  const ids = ["__proto__", "constructor", "toString", "hasOwnProperty", "__proto__-high", "constructor-20261017", "toString-20261017-low"];
  for (const id of ids) {
    assert.deepEqual(lookup(id), defaults);
    const model = toModel({ id });
    assert.equal(model.id, id);
    assert.equal(model.modelID, id);
    assert.deepEqual(model.limit, { context: 200000, output: 32000 });
    assert.deepEqual(model.cost, [{ input: 1, output: 5, cache: { read: 0, write: 0 } }]);
  }
  const models = buildModels([
    { id: "__proto__", context_window: 1000 },
    { id: "brand-new", context_window: 2000 },
    { id: "__proto__", context_window: 3000, display_name: "Exact duplicate winner" },
    { id: "constructor" },
  ]);
  assert.deepEqual(models.map((model) => model.id), ["__proto__", "brand-new", "constructor"]);
  assert.equal(models[0].limit.context, 3000);
  assert.equal(models[0].name, "Exact duplicate winner");
  assert.equal(models[0].modelID, "__proto__");
});

test("provided names remain byte-exact apart from edge whitespace, without a prefix", () => {
  for (const name of ["gpt-6-high", "Custom_mIxEd-high-preview-20261017", "RuRout-X  β", "a/b:c"]) {
    assert.equal(toModel({ id: name, display_name: name }).name, name);
    assert.equal(toModel({ id: "other", name }).name, name);
    assert.equal(toModel({ id: "other", display_name: name, name: "ignored" }).name, name);
  }
  assert.equal(toModel({ id: "other", display_name: " ", name: "Exact fallback" }).name, "Exact fallback");
});

test("high/low/tiered API IDs stay distinct, and the table never supplies inventory", () => {
  const ids = ["gemini-3-pro-low", "gemini-3-pro-high", "gemini-3-pro-tiered"];
  const models = buildModels(ids.map((id) => ({ id, supported_reasoning_levels: [] })));
  assert.deepEqual(models.map((m) => m.id), ids);
  assert.deepEqual(models.map((m) => m.modelID), ids);
  assert.ok(models.every((m) => m.variants.length === 0));
  assert.deepEqual(buildModels([]), []);
  assert.deepEqual(buildModels([{ id: "unknown" }]).map((m) => m.id), ["unknown"]);
});

test("API levels alone define supplied variants, including empty and new levels", () => {
  assert.deepEqual(toModel({ id: "gpt-6", supported_reasoning_levels: [] }).variants, []);
  assert.deepEqual(toModel({ id: "unknown", supported_reasoning_levels: ["xhigh"] }).variants,
    [{ id: "xhigh", settings: { reasoningEffort: "xhigh" } }]);
  assert.deepEqual(toModel({ id: "gpt-6" }).variants.map((v) => v.id), ["low", "medium", "high"]);
});

test("legacy metadata remains available when API metadata is absent", () => {
  const model = toModel({ id: "claude-opus-4-6" });
  assert.equal(model.name, "RuRout Claude Opus 4 6");
  assert.deepEqual(model.limit, { context: 1000000, output: 128000 });
  assert.deepEqual(model.cost, [{ input: 5, output: 25, cache: { read: 0.5, write: 0 } }]);
  assert.deepEqual(toModel({ id: "arbitrary-unknown" }).limit, { context: 200000, output: 32000 });
});

test("a fresh snapshot rebuilds context and pricing even when IDs do not change", () => {
  const entry = { id: "arbitrary-new", context_window: 4000, pricing: { currency: "USD", unit: "per_token", input_price: 0.000002 } };
  const before = buildModels([entry]);
  entry.context_window = 8000;
  entry.pricing.input_price = 0;
  const after = buildModels([entry]);
  assert.equal(before[0].limit.context, 4000);
  assert.equal(before[0].cost[0].input, 2);
  assert.equal(after[0].limit.context, 8000);
  assert.equal(after[0].cost[0].input, 0);
  assert.notStrictEqual(before[0], after[0]);
});
