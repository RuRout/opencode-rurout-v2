import { PROVIDER_ID } from "./constants.js";
import type { GatewayModel } from "./discovery.js";
import { displayName, effortSuffix, familyOf, isImage, isReasoning, lookup, supportsVision } from "./fallback.js";

function tokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return undefined;
  }
  return [...new Set(value.map((item: string) => item.trim()))];
}

const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

function modalities(value: unknown): string[] | undefined {
  const values = strings(value);
  return values?.every((item) => MODALITIES.has(item)) ? values : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function price(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const perMillion = value * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : undefined;
}

/** One API entry becomes one exact transport ID. The table supplies metadata,
 * never inventory, and only for fields the API omitted or supplied invalidly. */
export function toModel(entry: GatewayModel) {
  const id = entry.id;
  const fallback = lookup(id);
  const image = isImage(id);
  const text = !id.startsWith("gpt-image-") && !id.startsWith("dall-e-");
  const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : isReasoning(id);
  const suppliedName = label(entry.display_name) ?? label(entry.name);
  const fallbackName = displayName(id);
  const pricing = record(entry.pricing);
  // Currency and unit must be explicit: neither infer units nor coerce null,
  // strings or booleans into numbers. Zero is a valid API price.
  const validPricing = pricing?.currency === "USD" && pricing?.unit === "per_token" ? pricing : undefined;
  const levels = entry.reasoning === false ? [] : strings(entry.supported_reasoning_levels)
    ?? (reasoning || effortSuffix(id) ? ["low", "medium", "high"] : []);
  const context = tokenLimit(entry.context_window) ?? fallback.context;
  const inputLimit = tokenLimit(entry.max_input_tokens);
  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: suppliedName ?? (fallbackName.startsWith("RuRout") ? fallbackName : `RuRout ${fallbackName}`),
    family: familyOf(id),
    capabilities: {
      tools: typeof entry.supports_tools === "boolean" ? entry.supports_tools : !image && text,
      input: modalities(entry.input_modalities) ?? (supportsVision(id) ? ["text", "image"] : ["text"]),
      output: modalities(entry.output_modalities) ?? (image || !text ? ["image"] : ["text"]),
    },
    variants: levels.map((level) => ({ id: level, settings: { reasoningEffort: level } })),
    time: { released: 0 },
    cost: [{
      input: price(validPricing?.input_price) ?? fallback.input,
      output: price(validPricing?.output_price) ?? fallback.outputCost,
      cache: {
        read: price(validPricing?.cache_read_price) ?? fallback.cacheRead ?? 0,
        write: price(validPricing?.cache_write_price) ?? 0,
      },
    }],
    status: "active",
    enabled: true,
    limit: {
      context,
      ...(inputLimit !== undefined ? { input: Math.min(inputLimit, context) } : {}),
      output: Math.min(tokenLimit(entry.max_output_tokens) ?? fallback.output, context),
    },
    settings: { reasoning },
  };
}

export function buildModels(live: GatewayModel[]) {
  return [...new Map(live.map((entry) => [entry.id, entry])).values()].map(toModel);
}
