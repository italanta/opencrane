#!/usr/bin/env node
/**
 * oc — OpenCrane CLI entry point.
 *
 * Authentication:
 *   Run `oc auth login` to authenticate via the device authorization flow.
 *   The CLI opens a browser, waits for OIDC sign-in, and persists the issued
 *   token to ~/.config/opencrane/credentials.json automatically.
 *
 *   For CI / automation use the OPENCRANE_TOKEN environment variable with a
 *   token created via POST /access-tokens.  No interactive flow is needed.
 *
 * Server:
 *   Set OPENCRANE_URL or pass --url <url> (default: http://localhost:8080).
 *
 * Output:
 *   Pass --output json to any command for machine-readable output.
 *   Example: oc tenants list --output json | jq '.[].name'
 */

import { Command } from "commander";

import { type CliConfig, _ResolveConfig } from "./config.js";
import { _RegisterAudit } from "./commands/audit.js";
import { _RegisterAuth } from "./commands/auth.js";
import { _RegisterAwareness } from "./commands/awareness.js";
import { _RegisterBudget } from "./commands/budget.js";
import { _RegisterClusterTenants } from "./commands/cluster-tenants.js";
import { _RegisterMcpServers } from "./commands/mcp-servers.js";
import { _RegisterMetrics } from "./commands/metrics.js";
import { _RegisterPlatform } from "./commands/platform.js";
import { _RegisterPolicies } from "./commands/policies.js";
import { _RegisterProviders } from "./commands/providers.js";
import { _RegisterSessions } from "./commands/sessions.js";
import { _RegisterSkills } from "./commands/skills.js";
import { _RegisterTenants } from "./commands/tenants.js";
import { _RegisterTokens } from "./commands/tokens.js";

/** Root Commander program for the oc CLI. */
const program = new Command();

program
  .name("oc")
  .description("OpenCrane platform CLI — manage tenants, policies, budgets, MCP servers, and skills")
  .version("0.1.0")
  .option("--url <url>", "Control-plane base URL (overrides OPENCRANE_URL)", undefined);

/** Lazily resolved config — deferred so --help works without credentials. */
let _resolvedConfig: CliConfig | undefined;

/**
 * Resolve config once then return the cached result on subsequent calls.
 * Lazy resolution ensures --help and `oc auth login` work without a token.
 */
function _getConfig(): CliConfig
{
  if (!_resolvedConfig)
  {
    const opts = program.opts<{ url?: string }>();
    _resolvedConfig = _ResolveConfig(opts);
  }
  return _resolvedConfig;
}

// Register all command groups against the root program.
_RegisterTenants(program, _getConfig);
_RegisterClusterTenants(program, _getConfig);
_RegisterPolicies(program, _getConfig);
_RegisterMcpServers(program, _getConfig);
_RegisterSkills(program, _getConfig);
_RegisterBudget(program, _getConfig);
_RegisterAudit(program, _getConfig);
_RegisterTokens(program, _getConfig);
_RegisterProviders(program, _getConfig);
_RegisterMetrics(program, _getConfig);
_RegisterPlatform(program, _getConfig);
_RegisterAwareness(program, _getConfig);
_RegisterSessions(program, _getConfig);
_RegisterAuth(program, _getConfig);

program.parseAsync(process.argv).catch(function _onError(err: unknown)
{
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
