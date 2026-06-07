import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _PrintApiError, type OutputFormat } from "../format.js";

/** Register all `oc auth *` sub-commands on the given parent Command. */
export function _RegisterAuth(parent: Command, getConfig: () => CliConfig): void
{
  const auth = parent
    .command("auth")
    .description("Inspect and manage authentication state");

  auth
    .command("me")
    .description("Show current authentication status and identity (if any)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _me(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/auth/me");
      if (error) _PrintApiError("auth me", error);

      if (opts.output === "json")
      {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const status = data as { mode?: string; authenticated?: boolean; user?: { sub?: string; email?: string; name?: string } } | undefined;

      console.log(`Mode:          ${status?.mode ?? "unknown"}`);
      console.log(`Authenticated: ${status?.authenticated ?? false}`);
      if (status?.user)
      {
        console.log(`Subject:       ${status.user.sub ?? "-"}`);
        console.log(`Email:         ${status.user.email ?? "-"}`);
        console.log(`Name:          ${status.user.name ?? "-"}`);
      }
    });

  auth
    .command("logout")
    .description("Destroy the current server-side session (OIDC only; does not revoke the IdP session)")
    .action(async function _logout()
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.POST("/auth/logout", {});
      if (error) _PrintApiError("auth logout", error);
      console.log("Session destroyed.");
    });
}
