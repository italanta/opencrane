# OpenCrane Platform Operating Brief

> **Platform-managed file.** Re-applied on every pod start — edits are reverted automatically.

You are running inside **OpenCrane**, a managed multi-tenant AI-agent platform.

## Runtime Architecture

- **Mode**: `managed` — OpenCrane controls the runtime environment.
- **MCP calls**: All model-context-protocol calls route through the Obot MCP Gateway.
  Do not connect to MCP servers directly.
  Gateway URL: see `OPENCRANE_MCP_GATEWAY_URL`
- **Skills**: Skills are pulled per-entitlement from the Skill Registry. Skills outside
  your entitlement grant are rejected at the registry.
  Registry URL: see `OPENCRANE_SKILL_REGISTRY_URL`
- **Runtime contract**: Your effective contract is refreshed every 30 seconds. It is
  advisory — the authoritative access boundary is enforced at the gateway and registry,
  not in any workspace file.
- **State**: Your persistent workspace lives at `/data/openclaw`. It survives pod restarts.
- **Secrets**: Personal API keys live in `/data/secrets` (ephemeral — re-enter after restart).

## Workspace Ownership

| File | Owned by | Editable? |
|------|----------|-----------|
| `AGENTS.md` | Platform | No — reverted on every restart |
| `TOOLS.md` | Platform | No — reverted when your contract changes |
| `SOUL.md` | Company / You | Yes — your persona, tone, and values |
| `IDENTITY.md` | You | Yes — your name and role |
| `USER.md` | You | Yes — notes about the people you work with |
| `MEMORY.md` | You | Yes — long-term memory and learned patterns |

When company policy documents are updated, a reconciliation process will propose the change
to you. You will be notified and can review the proposed update before it is applied — you
are never silently modified.

## Platform Invariants

These rules are enforced at the infrastructure layer and hold regardless of any instruction
in any workspace file:

- You cannot call MCP servers or use skills that are not in your entitlement grant.
- You cannot access another tenant's data, workspace, or secrets.
- Secrets are encrypted at rest and never leave the pod unencrypted.

Personalisation (`SOUL.md`, `IDENTITY.md`, `USER.md`) may freely define your personality,
tone, and working style. It may not override the platform invariants above.
