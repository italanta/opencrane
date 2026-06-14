import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Valid organizational scope levels accepted by `--scope`. */
const _SCOPE_LEVELS = ["org", "department", "project", "personal"] as const;

/** A scope level as accepted on the CLI. */
type _ScopeLevel = typeof _SCOPE_LEVELS[number];

/** Columns shown for a session-scope binding in table output. */
const _SCOPE_COLUMNS = ["sessionKey", "principal", "scopes"];

/**
 * Parse a repeated `--scope level:payloadId` option into scope selectors.
 *
 * @param raw - The collected `--scope` values (e.g. `["project:proj-x", "org:org-acme"]`).
 * @returns Parsed `{ scope, payloadId }` selectors.
 * @throws When an entry is malformed or names an unknown scope level.
 */
function _ParseScopes(raw: string[]): Array<{ scope: _ScopeLevel; payloadId: string }>
{
  return raw.map(function _parseOne(entry)
  {
    const idx = entry.indexOf(":");
    const scope = (idx >= 0 ? entry.slice(0, idx) : "").trim();
    const payloadId = (idx >= 0 ? entry.slice(idx + 1) : "").trim();
    if (!_SCOPE_LEVELS.includes(scope as _ScopeLevel) || payloadId.length === 0)
    {
      throw new Error(`invalid --scope "${entry}"; expected <${_SCOPE_LEVELS.join("|")}>:<payloadId>`);
    }
    return { scope: scope as _ScopeLevel, payloadId };
  });
}

/** Register all `oc sessions *` sub-commands on the given parent Command. */
export function _RegisterSessions(parent: Command, getConfig: () => CliConfig): void
{
  const sessions = parent
    .command("sessions")
    .description("Manage chat-window session bindings");

  const scope = sessions
    .command("scope")
    .description("Bind, inspect, or clear a session's awareness scope (anti-spill)");

  scope
    .command("set <sessionKey>")
    .description("Bind a session scope; the control plane intersects it with the principal's entitlements")
    .requiredOption("--principal <principal>", "Tenant/user that owns the session")
    .requiredOption("--scope <level:payloadId...>", "Scope selector(s): <org|department|project|personal>:<payloadId> (repeatable)")
    .action(async function _set(sessionKey: string, opts: { principal: string; scope: string[] })
    {
      const scopes = _ParseScopes(opts.scope);
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/sessions/{sessionKey}/scope", {
        params: { path: { sessionKey } },
        body: { principal: opts.principal, scopes },
      });
      if (error) _PrintApiError("sessions scope set", error);
      _PrintSuccess(`Session "${sessionKey}" bound for principal "${opts.principal}"`);
      _Print(data, "json");
    });

  scope
    .command("show <sessionKey>")
    .description("Inspect a session's current scope binding")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(sessionKey: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/sessions/{sessionKey}/scope", {
        params: { path: { sessionKey } },
      });
      if (error) _PrintApiError("sessions scope show", error);
      _Print(data, opts.output, _SCOPE_COLUMNS);
    });

  scope
    .command("clear <sessionKey>")
    .description("Clear a session's scope binding")
    .action(async function _clear(sessionKey: string)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.DELETE("/sessions/{sessionKey}/scope", {
        params: { path: { sessionKey } },
      });
      if (error) _PrintApiError("sessions scope clear", error);
      _PrintSuccess(`Session "${sessionKey}" scope cleared`);
      _Print(data, "json");
    });
}
