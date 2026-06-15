# App: cli (`@opencrane/cli`, the `oc` command)

> Deep-dive for `apps/cli`. Index: [`../app-specific.md`](../app-specific.md). Verified June 2026.

A **thin, typed wrapper** over the control-plane API — Commander.js for parsing, the
`@opencrane/contracts` client for every call, **zero business logic**. The API/CLI-first rule means
every control-plane capability should have a matching command here.

## Structure (`src/index.ts`)

Root command `oc` registers command groups via `_Register*` functions: **tenants, cluster-tenant,
policies, mcp, skills, budget, audit, tokens, providers, metrics, platform, awareness, sessions,
auth**. Config is resolved lazily and cached, so `--help` and `oc auth login` work without
credentials.

## Config & Auth (`src/config.ts`)

`CliConfig = { baseUrl, token }`. Resolution precedence:

- **token:** `OPENCRANE_TOKEN` env (CI/automation) → `~/.config/opencrane/credentials.json` (written by `oc auth login`, mode `0600`) → `null` (commands exit with "Run `oc auth login`").
- **baseUrl:** `--url` flag → `OPENCRANE_URL` env → persisted credentials → `http://localhost:8080`.

`_MakeClient(config)` builds `___CreateControlPlaneClient(baseUrl, token)`. The CLI is stateless per invocation; the only persisted state is the credentials file.

## Auth Flow (`src/commands/auth.ts`)

- `oc auth login` — RFC 8628-style device flow: `POST /auth/device` → show activation URL → poll `/auth/device/token` every 5s (~5 min cap) → persist token + baseUrl.
- `oc auth me` — show current identity.
- `oc auth logout` — destroy server session + remove local credentials.

## Output (`src/format.ts`)

`_Print(data, format, columns?)`: **table** (default, auto-width, `(no results)` when empty, arrays shown as `[n items]`) or **json** (`--output json`, for piping). Errors route through `_PrintApiError` (extracts `error`/`code`, exits 1) for uniform messaging.

## Notable command shapes

`oc tenants create --name --display-name --email [--team --budget --policy-ref]`; `oc cluster-tenant create` builds the quota body from `--quota-{cpu,memory,pods,storage,gpu}` and placement from `--compute shared|dedicated [--node-pool]`; `oc skills create --name --version --digest [--scope]` (or `--body <json>`); `oc tokens create` prints the plaintext token once; `oc awareness rollout promote [--wave]`.
