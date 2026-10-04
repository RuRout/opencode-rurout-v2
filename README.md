# RuRout for OpenCode 2.x

OpenCode **2.x** provider plugin for [RuRout](https://rurout.ru) — your gateway key becomes a first-class provider in `/models`.

> For OpenCode **1.x** see [opencode-rurout-v1](https://github.com/RuRout/opencode-rurout-v1).

## What the client gets

- New `RuRout` provider in the OpenCode model picker, next to the built-ins.
- Model list discovered live from `GET /v1/models` with the active key — each client sees exactly the models that key allows.
- Single API key: a new key replaces the old model list (stale models are removed).
- The active key is checked on startup, instantly on account switch (stale models are wiped first, then rebuilt from `GET /v1/models` for the new key), on first use, every 5 seconds as a safety net, and hourly without a restart. Stale `~/.cache/opencode-rurout/models-*.json` files are deleted on startup.
- Startup never blocks OpenCode on the gateway: the last-known list for the active key (`~/.cache/opencode-rurout/v2-models-<key hash>.json`, model ids only, no key material) is shown instantly and refreshed live in the background. Without a cached list, startup waits at most 8 seconds. A failed refresh keeps the previous list; a rejected key clears it.

## Install (OpenCode 2.x only)

```sh
curl -fsSL https://rurout.ru/install.sh | sh -s -- --cli opencode2
```

The installer downloads `rurout-opencode-v2-<version>.tar.gz` from
`https://rurout.ru/downloads/connect/`, verifies its sha256 and unpacks it into
`~/.config/opencode/plugins/rurout-connect`. No npm is involved. To remove it:
`curl -fsSL https://rurout.ru/install.sh | sh -s -- --cli opencode2 --uninstall`.

Then inside OpenCode:

```
/connect
```

Select `rurout`, paste the gateway API key. Restart OpenCode, then `/models` → pick a `rurout/*` model.

Environment alternative (servers / CI):

```sh
export RUROUT_API_KEY=sk-...
opencode
```

## Custom gateway address

```sh
export RUROUT_BASE_URL=https://rurout.ru/v1
```

By default the plugin tries `https://rurout.ru/v1` and, if that address is
unreachable (for example a VPN or network blocks the domain), falls back to
`https://rurout.online/v1`; chat and image requests then use whichever address
answered. Existing installations configured with
`https://rurout.online:9443/v1` can keep that address. An explicit
`RUROUT_BASE_URL` is used as-is, without failover.

## How it works

1. `setup` registers the `rurout` integration (`key` method) so `/connect rurout` appears.
2. The provider shell is registered in the provider registry with `@opencode/ai/providers/openai-compatible` and the configured `baseURL`.
3. Models are fetched live from `{baseURL}/models` with the client's key and published into the registry via `models.set` + `reload()` — the same mechanism built-in dynamic providers use. Each key sees only its own allowlist; provider `settings` (`apiKey` + `baseURL`) travel with the registry so requests authenticate. Requires OpenCode 2.x (tested with 2.0.22, `@opencode/plugin` 2.0.22 API).

## Build the release archive

```sh
npm ci && npm run build
npm run release:pack   # writes release/rurout-opencode-v2-<version>.tar.gz and prints its sha256
npm run release:test   # builds twice and fails if the sha256 differs
```

The archive is deterministic (sorted names, fixed mtime/owner/mode, `gzip -n`),
so the same commit and toolchain always give the same sha256. That sha256 is
pinned in `install.sh` on rurout.ru.
