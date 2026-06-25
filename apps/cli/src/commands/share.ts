import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Options for `oc share grant`. */
interface _GrantOpts
{
  type: "mcp-server" | "skill-bundle";
  id: string;
  withUser?: string;
  withGroup?: string;
  scope?: "org" | "department" | "project" | "personal";
  note?: string;
}

/**
 * Register `oc share *` sub-commands: grant (share an entitlement you hold with another
 * user/group), list (the shares you created), and revoke (one you created). Sharing is
 * least-privilege bounded server-side — you can only share what you currently hold (S4).
 *
 * @param parent - The root commander program.
 * @param getConfig - Lazily resolves the CLI config (base URL + auth) per invocation.
 */
export function _RegisterShare(parent: Command, getConfig: () => CliConfig): void
{
  const share = parent
    .command("share")
    .description("Share an entitlement you hold with another user or group (list, grant, revoke)");

  share
    .command("grant")
    .description("Share an MCP server or skill bundle you hold with a user or group")
    .requiredOption("--type <type>", "Entitlement family: mcp-server|skill-bundle")
    .requiredOption("--id <payloadId>", "Id of the MCP server or skill bundle to share")
    .option("--with-user <subject>", "Recipient user's IdP subject")
    .option("--with-group <groupId>", "Recipient group id")
    .option("--scope <scope>", "Visibility scope: org|department|project|personal", "personal")
    .option("--note <text>", "Optional note recorded on the share")
    .action(async function _grant(opts: _GrantOpts)
    {
      // Exactly one recipient kind must be given so the share targets a single subject.
      if ((opts.withUser ? 1 : 0) + (opts.withGroup ? 1 : 0) !== 1)
      {
        _PrintApiError("share grant", { error: "Provide exactly one of --with-user or --with-group.", code: "VALIDATION_ERROR" });
        return;
      }
      const recipientType = opts.withUser ? "user" : "group";
      const recipientId = (opts.withUser ?? opts.withGroup) as string;
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/shares", {
        body: { payloadType: opts.type, payloadId: opts.id, recipientType, recipientId, scope: opts.scope, note: opts.note },
      });
      if (error) _PrintApiError("share grant", error);
      _PrintSuccess(`Shared ${opts.type} '${opts.id}' with ${recipientType} '${recipientId}'.`);
      console.log(JSON.stringify(data, null, 2));
    });

  share
    .command("list")
    .description("List the shares you have created")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/shares");
      if (error) _PrintApiError("share list", error);
      _Print(data, opts.output, ["id", "payloadType", "payloadId", "recipientType", "recipientId", "scope", "createdAt"]);
    });

  share
    .command("revoke <id>")
    .description("Revoke a share you created")
    .action(async function _revoke(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/shares/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("share revoke", error);
      _PrintSuccess(`Revoked share '${id}'.`);
    });
}
