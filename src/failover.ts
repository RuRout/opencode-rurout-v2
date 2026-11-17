import { DOMAIN_FAILBACK_CONFIRMATIONS, DOMAIN_PROBE_TIMEOUT_MS } from "./constants.js";

export type ProbeResult = "up" | "down";

/**
 * Idempotent reachability probe: `GET <base>/models`. Any HTTP response, of any
 * status, proves the domain is reachable; only a network-level failure (DNS,
 * refused, TLS/SNI reset, connect timeout) is "down". The paid client requests
 * are never involved. Cancellation through `signal` rejects with AbortError.
 */
export async function probeGateway(
  baseURL: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(DOMAIN_PROBE_TIMEOUT_MS), signal]),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // Only the status line matters; do not download the model list.
    void response.body?.cancel().catch(() => undefined);
    return "up";
  } catch {
    if (signal.aborted) {
      const err = new Error("probe cancelled");
      err.name = "AbortError";
      throw err;
    }
    return "down";
  }
}

export interface DomainMonitorDeps {
  /** Gateway addresses in priority order (primary first). */
  baseURLs: string[];
  getBase(): string;
  getKey(): Promise<string>;
  /** Publishes a new `baseURL` through the plugin's provider reload. */
  setBase(next: string): Promise<void>;
  /** True while a discovery sync runs: it chooses the address itself. */
  busy(): boolean;
  trace(msg: string): void;
  probe?: typeof probeGateway;
}

export interface DomainMonitor {
  tick(): Promise<void>;
  cancel(): void;
}

/**
 * Keeps the published `baseURL` on a reachable domain while a session is
 * running. At most one probe cycle is in flight. A dead active domain fails
 * over to the first reachable one at once (a reachable alternative is itself
 * the confirmation); returning to a higher-priority domain needs several
 * consecutive successful probes.
 */
export function createDomainMonitor(deps: DomainMonitorDeps): DomainMonitor {
  const probe = deps.probe ?? probeGateway;
  const list = deps.baseURLs;
  let current: AbortController | null = null;
  let candidate: string | undefined;
  let streak = 0;
  let allDownReported = false;

  function resetStreak(): void {
    candidate = undefined;
    streak = 0;
  }

  async function commit(next: string, base: string, key: string, signal: AbortSignal): Promise<void> {
    // The world may have moved while probing: a discovery sync started, the
    // address changed under us, or another account became active.
    if (signal.aborted || deps.busy() || deps.getBase() !== base) return;
    if ((await deps.getKey()) !== key || signal.aborted) return;
    resetStreak();
    allDownReported = false;
    deps.trace(`domain switched ${hostOf(base)} -> ${hostOf(next)}`);
    await deps.setBase(next);
  }

  async function cycle(signal: AbortSignal): Promise<void> {
    const key = await deps.getKey();
    if (!key || signal.aborted) return;
    const base = deps.getBase();
    const index = list.indexOf(base);
    if (index < 0) return;

    if ((await probe(base, key, signal)) === "down") {
      resetStreak();
      for (const other of list) {
        if (other === base) continue;
        if ((await probe(other, key, signal)) === "up") {
          await commit(other, base, key, signal);
          return;
        }
      }
      if (!allDownReported) {
        allDownReported = true;
        deps.trace("domain probe: no gateway domain reachable");
      }
      return;
    }

    allDownReported = false;
    for (const higher of list.slice(0, index)) {
      if ((await probe(higher, key, signal)) !== "up") continue;
      streak = candidate === higher ? streak + 1 : 1;
      candidate = higher;
      if (streak >= DOMAIN_FAILBACK_CONFIRMATIONS) await commit(higher, base, key, signal);
      return;
    }
    resetStreak();
  }

  return {
    async tick(): Promise<void> {
      if (current || deps.busy()) return;
      const ctrl = new AbortController();
      current = ctrl;
      try {
        await cycle(ctrl.signal);
      } catch {
        // Cancelled by an account change/unload, or a transient local error:
        // the next tick starts clean. A probe must never throw into the timer.
      } finally {
        if (current === ctrl) current = null;
      }
    },
    cancel(): void {
      current?.abort();
      resetStreak();
    },
  };
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return "unknown";
  }
}
