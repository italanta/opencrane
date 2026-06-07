import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Register all `oc tokens *` sub-commands on the given parent Command. */
export function _RegisterTokens(parent: Command, getConfig: () => CliConfig): void
{
  const tokens = parent
    .command("tokens")
    .description("Manage personal access tokens (list, create, revoke)");

  tokens
    .command("list")
    .description("List all issued access tokens (hashes only, never plaintext)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/access-tokens");
      if (error) _PrintApiError("tokens list", error);
      _Print(data, opts.output, ["id", "name", "owner", "createdAt", "expiresAt"]);
    });

  tokens
    .command("create")
    .description("Create a new access token. The plaintext token is shown once — save it.")
    .option("--name <name>", "Token name (label)", "default")
    .option("--owner <owner>", "Token owner (email or username)", "unknown")
    .option("--expires-at <iso>", "Expiry datetime in ISO-8601 format")
    .action(async function _create(opts: { name: string; owner: string; expiresAt?: string })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/access-tokens", {
        body: {
          name: opts.name,
          owner: opts.owner,
          ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
        },
      });
      if (error) _PrintApiError("tokens create", error);

      const result = data as { id?: string; plainTextToken?: string } | undefined;
      console.log(`Token ID:    ${result?.id ?? "(unknown)"}`);
      console.log(`Token value: ${result?.plainTextToken ?? "(not returned)"}`);
      console.log("\nStore this token securely — it will not be shown again.");
    });

  tokens
    .command("revoke <id>")
    .description("Revoke and permanently delete an access token")
    .action(async function _revoke(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/access-tokens/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("tokens revoke", error);
      _PrintSuccess(`Token "${id}" revoked`);
    });
}
