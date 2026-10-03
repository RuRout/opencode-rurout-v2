import { FALLBACK_CONTEXT, FALLBACK_OUTPUT } from "./constants.js";

export interface FallbackSpec {
  context: number;
  output: number;
  input: number;
  outputCost: number;
  cacheRead?: number;
}

function spec(
  context: number,
  output: number,
  input: number,
  outputCost: number,
  cacheRead = 0,
): FallbackSpec {
  return { context, output, input, outputCost, cacheRead };
}

// Costs are USD per 1M tokens (from the gateway pricing catalog).
// Suffix-stripped variants (thinking/preview/high/medium/low/tiered/dates)
// resolve to the base entry in `lookup`.
const TABLE: Record<string, FallbackSpec> = {
  "claude-haiku-4-5": spec(200000, 64000, 1, 5, 0.1),
  "claude-opus-4-5": spec(200000, 64000, 5, 25, 0.5),
  "claude-opus-4-6": spec(1000000, 128000, 5, 25, 0.5),
  "claude-sonnet-4-5": spec(200000, 64000, 3, 15, 0.3),
  "claude-sonnet-4-6": spec(1000000, 64000, 3, 15, 0.3),
  "gemini-2.5-flash": spec(1048576, 65535, 0.3, 2.5),
  "gemini-2.5-flash-lite": spec(1048576, 65535, 0.1, 0.4),
  "gemini-2.5-pro": spec(1048576, 65535, 1.25, 10),
  "gemini-3-flash": spec(1048576, 65535, 0.5, 3),
  "gemini-3-pro-image": spec(65536, 32768, 2, 12),
  "gemini-3-pro-preview": spec(1048576, 65535, 2, 12),
  "gemini-3.1-flash-image": spec(65536, 32768, 0.5, 3),
  "gemini-3.1-pro-high": spec(1048576, 65536, 2, 12),
  "gemini-3.1-pro-low": spec(1048576, 65536, 2, 12),
  "gemini-3.1-pro-preview": spec(1048576, 65536, 2, 12),
  "gemini-3.6-flash": spec(1048576, 65536, 1.5, 7.5),
  "gemini-3.7-flash": spec(1048576, 65536, 1.5, 7.5),
  "gemini-3.8-flash": spec(1048576, 65536, 1.5, 7.5),
  "gemini-3-pro-high": spec(1048576, 65535, 2, 12),
  "gemini-3-pro-low": spec(1048576, 65535, 2, 12),
  "gemini-3.1-pro": spec(1048576, 65536, 2, 12),
  "gemini-pro-agent": spec(1048576, 65535, 2, 12),
  "gpt-oss-120b-medium": spec(131072, 65536, 0.3, 1.5),
  "tab_flash_lite_preview": spec(65536, 32768, 0.5, 1.5),
  "gpt-5.5": spec(1050000, 128000, 5, 30),
  "gpt-5.6": spec(1050000, 128000, 2, 12),
  "gpt-5.6-luna": spec(1050000, 128000, 0.2, 1.2),
  "gpt-5.6-sol": spec(1050000, 128000, 5, 30),
  "gpt-5.6-terra": spec(1050000, 128000, 2, 12),
  "gpt-6": spec(1050000, 128000, 5, 30),
  "gpt-6-astra": spec(1050000, 128000, 5, 30),
  "gpt-image-1": spec(131072, 32000, 5, 10),
  "gpt-image-1.5": spec(131072, 32000, 5, 10),
  "gpt-image-2": spec(131072, 32000, 5, 10),
  "gpt-image-2.5-flare": spec(131072, 32000, 5, 10),
  "gpt-image-2.5-sunburst": spec(131072, 32000, 5, 10),
  "dall-e-3": spec(32768, 8192, 5, 40),
};

const SUFFIX = /-(thinking|preview|high|medium|low|tiered)$/;
const DATE = /-\d{8}$/;

export function lookup(id: string): FallbackSpec {
  const direct = TABLE[id];
  if (direct) return direct;
  const noSuffix = id.replace(SUFFIX, "");
  if (TABLE[noSuffix]) return TABLE[noSuffix];
  const noDate = id.replace(DATE, "");
  if (TABLE[noDate]) return TABLE[noDate];
  const noBoth = noSuffix.replace(DATE, "");
  if (TABLE[noBoth]) return TABLE[noBoth];
  return {
    context: FALLBACK_CONTEXT,
    output: FALLBACK_OUTPUT,
    input: 1,
    outputCost: 5,
  };
}

export function familyOf(id: string): string {
  if (id.startsWith("claude-")) return "Claude";
  if (id.startsWith("gemini-")) return "Gemini";
  if (id.startsWith("gpt-")) return "GPT";
  return "RuRout";
}

export function isReasoning(id: string): boolean {
  const model = stripEffortSuffix(id).replace(/-thinking$/i, "");
  return /^(claude-(opus|sonnet)-|gemini-(2\.5-(pro|flash)|3|3\.1-pro)|gpt-(5|6|oss)|o[134])/i.test(model)
    || id.includes("thinking");
}

export function effortSuffix(id: string): string | undefined {
  const m = id.match(/-(high|medium|low|tiered)$/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

export function stripEffortSuffix(id: string): string {
  return id.replace(/-(high|medium|low|tiered)$/i, "");
}

export function supportsEffortVariants(id: string): boolean {
  return /-tiered$/i.test(id);
}

export function canonicalId(id: string): string {
  let s = id.trim();
  s = s.replace(/-tiered$/i, "");
  s = s.replace(/-thinking$/i, "");
  s = s.replace(/-preview$/i, "");
  s = s.replace(/-(\d{8})$/, "");
  const suffix = s.match(/-(high|medium|low)$/i);
  if (suffix) {
    const m = suffix[0];
    const base = s.slice(0, -m.length);
    if (/flash$/i.test(base)) return base;
    if (/^gemini-3-pro$/i.test(base)) return "gemini-3-pro";
    if (/^gemini-3\.1-pro$/i.test(base)) return "gemini-3.1-pro";
  }
  return s;
}

export function modelLabel(canonical: string): string {
  return `RuRout ${displayName(canonical, canonical)}`;
}

export function isImage(id: string): boolean {
  return id.includes("image") || id.startsWith("dall-e");
}

export function supportsVision(id: string): boolean {
  // Pure image generation output models don't take general vision prompts in normal chat
  if (id.startsWith("gpt-image-") || id.startsWith("dall-e-")) {
    return false;
  }
  // Modern frontier families support vision input (Claude 3+, GPT-4/5/6+, Gemini, etc.)
  if (id.startsWith("claude-") || id.startsWith("gpt-") || id.startsWith("gemini-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return true;
  }
  // By default, if the model has image in the name (e.g. multimodal models), allow vision
  return isImage(id);
}

export function displayName(id: string, display?: string): string {
  const normalized = normalize(id, display);
  const words = normalized
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w, i) => titleWord(w, i === 0));
  return words.join(" ");
}

function normalize(id: string, display?: string): string {
  const raw = display && display.length > 0 && display !== id ? display : id;
  if (/^tab_flash_lite_preview$/i.test(raw.trim())) return "Tab Flash Lite Preview";
  let s = raw.trim();
  s = s.replace(/-tiered$/i, "");
  s = s.replace(/-thinking$/i, " Thinking");
  s = s.replace(/-preview$/i, "");
  s = s.replace(/-(\d{8})$/, "");
  s = s.replace(/^gpt-/i, "GPT-");
  s = s.replace(/^claude-/i, "Claude ");
  s = s.replace(/^gemini-/i, "Gemini ");
  s = s.replace(/-(sonnet|opus|haiku)(?=-|$)/gi, " $1");
  s = s.replace(/-(pro|flash|lite|image|agent|max|mini|nano)(?=-|$)/gi, " $1");
  s = s.replace(/-(high|medium|low)(?=-|$)/gi, "");
  s = s.replace(/-(luna|sol|terra|astra)$/i, " ($1)");
  return s;
}

function titleWord(w: string, first: boolean): string {
  if (/^(v?\d+(\.\d+)+|\d+b|\d+k)$/i.test(w)) return w;
  const lower = w.toLowerCase();
  if (lower === "gpt" || lower === "gpt-") return "GPT";
  if (lower === "oss") return "OSS";
  if (lower === "sonnet") return "Sonnet";
  if (lower === "opus") return "Opus";
  if (lower === "haiku") return "Haiku";
  if (lower === "luna" || lower === "sol" || lower === "terra" || lower === "astra") {
    return w[0]!.toUpperCase() + w.slice(1);
  }
  if (lower === "claude" || lower === "gemini") return first ? w[0]!.toUpperCase() + w.slice(1) : w;
  if (/^\d/.test(w)) {
    const parts = w.split(".");
    if (parts.length === 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
      return `${parts[0]}.${parts[1]}`;
    }
    return w.toUpperCase();
  }
  return w[0]!.toUpperCase() + w.slice(1);
}
