export const PROVIDER_ID = "rurout";
export const PROVIDER_NAME = "RuRout";
// Tried in order: some networks and VPN exits block one of the domains by SNI.
// rurout.com is the primary domain; .ru and .online are working reserves
// served by the same gateway.
export const DEFAULT_BASE_URLS = [
  "https://rurout.com/v1",
  "https://rurout.ru/v1",
  "https://rurout.online/v1",
];
export const DISCOVERY_TIMEOUT_MS = 15000;
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const FALLBACK_CONTEXT = 200000;
export const FALLBACK_OUTPUT = 32000;
// Mid-session domain monitor. OpenCode 2.x gives the provider only serializable
// settings, so a dead domain can only be fixed by republishing `baseURL`.
// 30 s keeps the worst-case window of failed requests short while costing one
// tiny GET /models per 30 s per running client (thousands of clients stay
// negligible next to normal traffic); 5 s is enough for a healthy connect+TLS.
export const DOMAIN_PROBE_INTERVAL_MS = 30_000;
export const DOMAIN_PROBE_TIMEOUT_MS = 5_000;
// A higher-priority domain must answer this many consecutive probes before the
// plugin moves back to it, so a flapping domain cannot make the address bounce.
export const DOMAIN_FAILBACK_CONFIRMATIONS = 2;
