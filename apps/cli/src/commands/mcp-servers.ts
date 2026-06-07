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
    .option("--transport <transport>", "Transport: streamable-http|sse|websocket", "streamable-http")
    .option("--body <json>", "Full JSON payload (overrides individual flags)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _create(opts: {
      name: string;
      endpoint: string;
      transport: string;
      body?: string;
      output: OutputFormat;
    })
    {
      const body = opts.body
        ? JSON.parse(opts.body)
        : { name: opts.name, endpoint: opts.endpoint, transport: opts.transport };

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
}
