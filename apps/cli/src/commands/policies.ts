import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Register all `oc policies *` sub-commands on the given parent Command. */
export function _RegisterPolicies(parent: Command, getConfig: () => CliConfig): void
{
  const policies = parent
    .command("policies")
    .description("Manage AccessPolicies (list, get, create, update, delete, drift, repair)");

  policies
    .command("list")
    .description("List all access policies")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/policies");
      if (error) _PrintApiError("policies list", error);
      _Print(data, opts.output, ["name", "description", "createdAt"]);
    });

  policies
    .command("get <name>")
    .description("Get a single access policy by name")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _get(name: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/policies/{name}", { params: { path: { name } } });
      if (error) _PrintApiError("policies get", error);
      _Print(data, opts.output);
    });

  policies
    .command("create")
    .description("Create an access policy from a JSON body (--body or stdin)")
    .option("--body <json>", "JSON payload for the policy spec")
    .action(async function _create(opts: { body?: string })
    {
      const body = opts.body ? JSON.parse(opts.body) : await _readStdin();
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/policies", { body });
      if (error) _PrintApiError("policies create", error);
      console.log(JSON.stringify(data, null, 2));
    });

  policies
    .command("update <name>")
    .description("Update an access policy from a JSON body (--body or stdin)")
    .option("--body <json>", "JSON payload for the policy spec update")
    .action(async function _update(name: string, opts: { body?: string })
    {
      const body = opts.body ? JSON.parse(opts.body) : await _readStdin();
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/policies/{name}", { params: { path: { name } }, body });
      if (error) _PrintApiError("policies update", error);
      console.log(JSON.stringify(data, null, 2));
    });

  policies
    .command("delete <name>")
    .description("Delete an access policy")
    .action(async function _delete(name: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/policies/{name}", { params: { path: { name } } });
      if (error) _PrintApiError("policies delete", error);
      _PrintSuccess(`Policy "${name}" deleted`);
    });

  policies
    .command("drift")
    .description("Report projection drift between AccessPolicy CRDs and database")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _drift(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/policies/drift");
      if (error) _PrintApiError("policies drift", error);
      _Print(data, opts.output);
    });

  policies
    .command("repair")
    .description("Repair AccessPolicy projection rows from CRD source of truth")
    .option("--apply", "Apply changes (default is dry-run)", false)
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _repair(opts: { apply: boolean; output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/policies/repair", {
        params: { query: { dryRun: !opts.apply } },
      });
      if (error) _PrintApiError("policies repair", error);
      _Print(data, opts.output);
    });
}

/**
 * Consume all of stdin and parse the contents as JSON.
 * Used when --body is not passed; allows piping policy specs from files.
 */
async function _readStdin(): Promise<unknown>
{
  // 1. Collect incoming chunks into a buffer list to avoid string concatenation overhead.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
  {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  // 2. Join all chunks and decode as UTF-8 before parsing.
  const raw = Buffer.concat(chunks).toString("utf8");

  // 3. Parse the complete JSON document and return it as the request body.
  return JSON.parse(raw);
}
