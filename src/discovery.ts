import { DISCOVERY_TIMEOUT_MS } from "./constants.js";

export interface GatewayModel {
  id: string;
  display_name?: string;
  created_at?: string;
}

export async function fetchGatewayModels(
  baseURL: string,
  apiKey: string,
  attempts = 3,
  signal?: AbortSignal,
): Promise<GatewayModel[]> {
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), signal])
          : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      // A newer sync superseded this one — never retry, never report.
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (signal?.aborted) throw abortError(signal);
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(300 * (attempt + 1));
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("gateway rejected the API key (invalid or disabled)");
    }
    if (!response.ok) {
      lastError = `${response.status} ${response.statusText}`;
      await sleep(300 * (attempt + 1));
      continue;
    }
    const body = (await response.json()) as { data?: GatewayModel[] };
    const list = Array.isArray(body.data) ? body.data : [];
    const models = list.filter((m) => typeof m?.id === "string" && m.id.length > 0);
    return models;
  }
  throw new Error(`gateway discovery failed at ${url}: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(signal: AbortSignal): Error {
  const err = signal.reason instanceof Error ? signal.reason : new Error("sync superseded");
  err.name = "AbortError";
  return err;
}
