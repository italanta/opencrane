import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Register all `oc mcp *` sub-commands on the given parent Command. */
export function _RegisterMcpServers(parent: Command, getConfig: () => CliConfig): void
{
  const mcp = parent
    .command("mcp")
    .description("Manage MCP servers (list, get, create, update, delete)");

  mcp
    .command("list")
    .description("List all MCP servers")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/mcp-servers");
      if (error) _PrintApiError("mcp list", error);
      _Print(data, opts.output, ["id", "name", "transport", "endpoint"]);
    });

  mcp
    .command("get <id>")
    .description("Get a single MCP server by identifier")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _get(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/mcp-servers/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("mcp get", error);
      _Print(data, opts.output);
    });

  mcp
    .command("create")
    .description("Create a new MCP server")
    .requiredOption("--name <name>", "Display name")
    .requiredOption("--endpoint <endpoint>", "Server endpoint URL")
    .option("--scope <scope>", "Scope: org|department|project|personal")
    .option("--transport <transport>", "Transport: streamable-http|sse|websocket", "streamable-http")
    .option("--body <json>", "Full JSON payload (overrides individual flags)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _create(opts: {
      name: string;
      endpoint: string;
      scope?: string;
      transport: string;
      body?: string;
      output: OutputFormat;
    })
    {
      if (!opts.body && !opts.scope)
      {
        _PrintApiError("mcp create", { error: "scope is required unless --body is used", code: "VALIDATION_ERROR" });
      }

      const body = opts.body
        ? JSON.parse(opts.body)
        : { name: opts.name, endpoint: opts.endpoint, scope: opts.scope, transport: opts.transport };

      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/mcp-servers", { body });
      if (error) _PrintApiError("mcp create", error);
      _Print(data, opts.output);
    });

  mcp
    .command("update <id>")
    .description("Update an MCP server (pass --body JSON or individual flags)")
    .option("--name <name>", "New display name")
    .option("--endpoint <endpoint>", "New endpoint URL")
    .option("--transport <transport>", "New transport")
    .option("--body <json>", "Full JSON payload (overrides individual flags)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _update(id: string, opts: {
      name?: string;
      endpoint?: string;
      transport?: string;
      body?: string;
      output: OutputFormat;
    })
    {
      const body = opts.body
        ? JSON.parse(opts.body)
        : {
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
            ...(opts.transport ? { transport: opts.transport } : {}),
          };

      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/mcp-servers/{id}", { params: { path: { id } }, body });
      if (error) _PrintApiError("mcp update", error);
      _Print(data, opts.output);
    });

  mcp
    .command("delete <id>")
    .description("Delete an MCP server and its linked grants")
    .action(async function _delete(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/mcp-servers/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("mcp delete", error);
      _PrintSuccess(`MCP server "${id}" deleted`);
    });

  // ----------------------------------------------------------------------
  // Downstream-credential brokering (P4D.1): author per-server credentials.
  // ----------------------------------------------------------------------
  const cred = mcp
    .command("cred")
    .description("Manage brokered downstream credentials on an MCP server");

  cred
    .command("list <serverId>")
    .description("List the brokered credentials of an MCP server")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _credList(serverId: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/mcp-servers/{id}/credentials", { params: { path: { id: serverId } } });
      if (error) _PrintApiError("mcp cred list", error);
      _Print(data, opts.output, ["id", "displayName", "brokeringMode", "secretRef"]);
    });

  cred
    .command("add <serverId>")
    .description("Add a brokered credential (static secret fallback or per-user OBO)")
    .requiredOption("--display-name <name>", "Operator-facing credential label")
    .option("--mode <mode>", "Brokering mode: static|obo", "static")
    .option("--secret-ref <ref>", "Secret reference (required for --mode static, omit for obo)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _credAdd(serverId: string, opts: {
      displayName: string;
      mode: string;
      secretRef?: string;
      output: OutputFormat;
    })
    {
      const body = {
        displayName: opts.displayName,
        brokeringMode: opts.mode as "static" | "obo",
        ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
      };

      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/mcp-servers/{id}/credentials", { params: { path: { id: serverId } }, body });
      if (error) _PrintApiError("mcp cred add", error);
      _Print(data, opts.output);
    });

  cred
    .command("rm <serverId> <credentialId>")
    .description("Remove a single brokered credential from an MCP server")
    .action(async function _credRm(serverId: string, credentialId: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/mcp-servers/{id}/credentials/{credentialId}", { params: { path: { id: serverId, credentialId } } });
      if (error) _PrintApiError("mcp cred rm", error);
      _PrintSuccess(`MCP credential "${credentialId}" removed from server "${serverId}"`);
    });
}
