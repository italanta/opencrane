import type { Command } from "commander";

import type { ModelDefinitionWrite } from "@opencrane/contracts";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Columns shown for `oc model list` in table mode. */
const _LIST_COLUMNS = ["id", "scope", "clusterTenant", "publicModelName", "upstreamModel", "isDefault"];

/** Flag values for `oc model list`. */
interface _ModelListOptions
{
  /** Filter to a single ClusterTenant's models. */
  clusterTenant?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc model add`. */
interface _ModelAddOptions
{
  /** Routable public slug callers request, e.g. `openai/gpt-4o`. */
  name: string;
  /** Upstream model the deployment targets. */
  upstream: string;
  /** Optional non-default API base for self-hosted / proxied endpoints. */
  apiBase?: string;
  /** Scope: global | clusterTenant (defaults to global server-side). */
  scope?: string;
  /** Owning ClusterTenant when scope is clusterTenant. */
  clusterTenant?: string;
  /** Provider credential backing this model. */
  credential?: string;
  /** Whether this is the default model at its scope. */
  default?: boolean;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc model update`. */
interface _ModelUpdateOptions
{
  /** New upstream model. */
  upstream?: string;
  /** New API base. */
  apiBase?: string;
  /** Whether this is the default model at its scope. */
  default?: boolean;
  /** Output format. */
  output: OutputFormat;
}

/** Register all `oc model *` sub-commands on the given parent Command. */
export function _RegisterModel(parent: Command, getConfig: () => CliConfig): void
{
  const model = parent
    .command("model")
    .description("Manage the model registry — routable BYOM model definitions (list, show, add, update, remove)");

  model
    .command("list")
    .description("List model definitions, optionally scoped to a single cluster tenant")
    .option("--cluster-tenant <id>", "Filter to one cluster tenant's models")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _ModelListOptions)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/models", {
        params: { query: opts.clusterTenant ? { clusterTenant: opts.clusterTenant } : {} },
      });
      if (error) _PrintApiError("model list", error);
      _Print(data, opts.output, _LIST_COLUMNS);
    });

  model
    .command("show <id>")
    .description("Show a single model definition by id")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/models/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("model show", error);
      _Print(data, opts.output);
    });

  model
    .command("add")
    .description("Register a new model definition (registered best-effort with LiteLLM)")
    .requiredOption("--name <publicModelName>", "Routable public slug, e.g. openai/gpt-4o")
    .requiredOption("--upstream <upstreamModel>", "Upstream model the deployment targets")
    .option("--api-base <url>", "Non-default API base for self-hosted / proxied endpoints")
    .option("--scope <scope>", "Scope: global|clusterTenant")
    .option("--cluster-tenant <id>", "Owning cluster tenant (required when --scope clusterTenant)")
    .option("--credential <providerCredentialId>", "Provider credential backing this model")
    .option("--default", "Mark as the default model at its scope")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _add(opts: _ModelAddOptions)
    {
      // 1. Assemble the typed write body from the supplied flags. The scope
      //    string is passed through so the API stays the single validator.
      const body: ModelDefinitionWrite = {
        publicModelName: opts.name,
        upstreamModel: opts.upstream,
        ...(opts.apiBase ? { apiBase: opts.apiBase } : {}),
        ...(opts.scope ? { scope: opts.scope as ModelDefinitionWrite["scope"] } : {}),
        ...(opts.clusterTenant ? { clusterTenant: opts.clusterTenant } : {}),
        ...(opts.credential ? { providerCredentialId: opts.credential } : {}),
        ...(opts.default ? { isDefault: true } : {}),
      };

      // 2. POST through the generated client — just another API client.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/models", { body });
      if (error) _PrintApiError("model add", error);
      _Print(data, opts.output);
    });

  model
    .command("update <id>")
    .description("Update a model definition (only the supplied fields change)")
    .option("--upstream <upstreamModel>", "New upstream model")
    .option("--api-base <url>", "New API base")
    .option("--default", "Mark as the default model at its scope")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _update(id: string, opts: _ModelUpdateOptions)
    {
      // 1. Build a partial body: only flags the caller passed are sent, so the
      //    API applies a targeted patch rather than overwriting unset fields.
      const body: Partial<ModelDefinitionWrite> = {
        ...(opts.upstream ? { upstreamModel: opts.upstream } : {}),
        ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
        ...(opts.default ? { isDefault: true } : {}),
      };

      // 2. PUT through the generated client; server-side validation owns the rules.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/models/{id}", {
        params: { path: { id } },
        body: body as ModelDefinitionWrite,
      });
      if (error) _PrintApiError("model update", error);
      _Print(data, opts.output);
    });

  model
    .command("remove <id>")
    .description("Delete a model definition")
    .action(async function _remove(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/models/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("model remove", error);
      _PrintSuccess(`Model "${id}" removed`);
    });
}
