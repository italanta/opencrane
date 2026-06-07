import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Register all `oc providers *` sub-commands on the given parent Command. */
export function _RegisterProviders(parent: Command, getConfig: () => CliConfig): void
{
  const providers = parent
    .command("providers")
    .description("Manage provider API keys (list, set, delete)");

  providers
    .command("list")
    .description("List configured provider keys (configured status only, key value never returned)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/providers/keys");
      if (error) _PrintApiError("providers list", error);
      _Print(data, opts.output, ["provider", "configured", "updatedAt"]);
    });

  providers
    .command("set <provider> <key>")
    .description("Create or update a provider API key (openai, claude, etc.)")
    .action(async function _set(provider: string, key: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.PUT("/providers/keys", {
        body: { provider, apiKey: key },
      });
      if (error) _PrintApiError("providers set", error);
      _PrintSuccess(`Provider key for "${provider}" updated`);
    });

  providers
    .command("delete <provider>")
    .description("Delete a configured provider API key")
    .action(async function _delete(provider: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/providers/keys/{provider}", {
        params: { path: { provider } },
      });
      if (error) _PrintApiError("providers delete", error);
      _PrintSuccess(`Provider key for "${provider}" deleted`);
    });
}
