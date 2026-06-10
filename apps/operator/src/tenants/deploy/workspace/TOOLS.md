# Available Tools

> **Platform-managed file.** Reflects your current entitlements — re-applied when your contract changes.
> Edits are reverted automatically.

## MCP Gateway

All MCP server calls route through the gateway at `OPENCRANE_MCP_GATEWAY_URL`.

Your entitled MCP servers are listed in your runtime contract. The current allow-list is
available in `OPENCRANE_ALLOWED_MCP_SERVERS` at startup and refreshed every 30 seconds.

## Skill Registry

Skills are fetched from `OPENCRANE_SKILL_REGISTRY_URL`.

Your entitled skills are listed in your runtime contract (`skills.entitled`).

## LiteLLM Proxy (if enabled)

When `LITELLM_ENDPOINT` is set, model requests route through the LiteLLM proxy.
Configure your preferred model via `LITELLM_ENDPOINT`.
