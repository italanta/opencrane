import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";
import type { ClusterTenantCreateOptions, ClusterTenantQuotaBody, ClusterTenantQuotaOptions, ClusterTenantUpdateOptions } from "./cluster-tenants.types.js";

/** Columns shown for `oc cluster-tenant list` in table mode. */
const _LIST_COLUMNS = ["name", "displayName", "isolationTier", "compute", "resources", "status"];

/**
 * Build the resource-quota body block from the raw quota flags.
 * Numeric flags (pods, gpu) are coerced via Number so the API receives the
 * integer shape it expects; blank flags are omitted entirely.
 *
 * @param opts - Quota flag values from the create or update sub-command.
 * @returns A quota object containing only the flags that were supplied.
 */
export function _BuildQuotaBody(opts: ClusterTenantQuotaOptions): ClusterTenantQuotaBody
{
  return {
    ...(opts.quotaCpu ? { cpu: opts.quotaCpu } : {}),
    ...(opts.quotaMemory ? { memory: opts.quotaMemory } : {}),
    ...(opts.quotaPods ? { pods: Number(opts.quotaPods) } : {}),
    ...(opts.quotaStorage ? { storage: opts.quotaStorage } : {}),
    ...(opts.quotaGpu ? { gpu: Number(opts.quotaGpu) } : {}),
  };
}

/**
 * Build the compute placement block from the --compute / --node-pool flags.
 * The mode string is passed straight through so the API remains the single
 * authority that validates allowed values (and that dedicated needs a pool).
 *
 * @param compute  - Compute mode flag value (shared | dedicated).
 * @param nodePool - Optional dedicated node pool name.
 * @returns A compute block matching the ClusterTenantWrite contract shape.
 */
function _buildComputeBody(compute: string, nodePool?: string): { mode: "shared" | "dedicated"; nodePool?: string }
{
  return {
    mode: compute as "shared" | "dedicated",
    ...(nodePool ? { nodePool } : {}),
  };
}

/** Register all `oc cluster-tenant *` sub-commands on the given parent Command. */
export function _RegisterClusterTenants(parent: Command, getConfig: () => CliConfig): void
{
  const clusterTenant = parent
    .command("cluster-tenant")
    .description("Manage cluster tenants — the first-class customer / isolation unit (create, list, show, update, delete, status, refresh)");

  clusterTenant
    .command("list")
    .description("List all cluster tenants")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/cluster-tenants");
      if (error) _PrintApiError("cluster-tenant list", error);
      _Print(data, opts.output, _LIST_COLUMNS);
    });

  clusterTenant
    .command("show <name>")
    .description("Show a single cluster tenant by name")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(name: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/cluster-tenants/{name}", { params: { path: { name } } });
      if (error) _PrintApiError("cluster-tenant show", error);
      _Print(data, opts.output);
    });

  clusterTenant
    .command("status <name>")
    .description("Show just the observed status of a cluster tenant")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _status(name: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/cluster-tenants/{name}/status", { params: { path: { name } } });
      if (error) _PrintApiError("cluster-tenant status", error);
      _Print(data, opts.output);
    });

  clusterTenant
    .command("refresh <name>")
    .description("Refresh a cluster tenant's status and seed its owner workspace tenant if the org is ready but has none")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _refresh(name: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/cluster-tenants/{name}/refresh", { params: { path: { name } } });
      if (error) _PrintApiError("cluster-tenant refresh", error);
      _Print(data, opts.output);
    });

  clusterTenant
    .command("create <name>")
    .description("Create a new cluster tenant")
    .requiredOption("--display-name <displayName>", "Human-readable customer name")
    .option("--vanity-domain <domain>", "Optional customer-vanity domain CNAMEd onto the org apex (e.g. ai.client-company.com)")
    .requiredOption("--tier <tier>", "Isolation tier: shared|dedicatedNodes|dedicatedCluster")
    .option("--compute <mode>", "Compute placement: shared|dedicated", "shared")
    .option("--node-pool <nodePool>", "Dedicated node pool name (required when --compute dedicated)")
    .option("--quota-cpu <cpu>", "CPU quota (e.g. '4', '500m')")
    .option("--quota-memory <memory>", "Memory quota (e.g. '8Gi')")
    .option("--quota-pods <pods>", "Maximum number of pods")
    .option("--quota-storage <storage>", "Persistent storage quota (e.g. '100Gi')")
    .option("--quota-gpu <gpu>", "Total GPUs")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _create(name: string, opts: ClusterTenantCreateOptions)
    {
      // 1. Assemble the typed write body from the supplied flags. The mode/tier
      //    strings are passed through so the API stays the single validator.
      const body = {
        name,
        displayName: opts.displayName,
        ...(opts.vanityDomain ? { vanityDomain: opts.vanityDomain } : {}),
        isolationTier: opts.tier as "shared" | "dedicatedNodes" | "dedicatedCluster",
        compute: _buildComputeBody(opts.compute, opts.nodePool),
        resources: { quota: _BuildQuotaBody(opts) },
      };

      // 2. POST through the generated client — just another API client, no
      //    privileged path. An over-tier request surfaces the API's 422.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/cluster-tenants", { body });

      // 3. Surface any API error as a clean CLI message (not a stack trace).
      if (error) _PrintApiError("cluster-tenant create", error);
      _Print(data, opts.output);
    });

  clusterTenant
    .command("update <name>")
    .description("Update a cluster tenant (only the supplied fields change)")
    .option("--display-name <displayName>", "New human-readable customer name")
    .option("--vanity-domain <domain>", "New customer-vanity domain CNAMEd onto the org apex (e.g. ai.client-company.com)")
    .option("--tier <tier>", "New isolation tier: shared|dedicatedNodes|dedicatedCluster")
    .option("--compute <mode>", "New compute placement: shared|dedicated")
    .option("--node-pool <nodePool>", "New dedicated node pool name")
    .option("--quota-cpu <cpu>", "New CPU quota (e.g. '4', '500m')")
    .option("--quota-memory <memory>", "New memory quota (e.g. '8Gi')")
    .option("--quota-pods <pods>", "New maximum number of pods")
    .option("--quota-storage <storage>", "New persistent storage quota (e.g. '100Gi')")
    .option("--quota-gpu <gpu>", "New total GPUs")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _update(name: string, opts: ClusterTenantUpdateOptions)
    {
      // 1. Build a partial body: only flags the caller passed are sent, so the
      //    API applies a targeted patch rather than overwriting unset fields.
      const quota = _BuildQuotaBody(opts);
      const body = {
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        ...(opts.vanityDomain !== undefined ? { vanityDomain: opts.vanityDomain } : {}),
        ...(opts.tier ? { isolationTier: opts.tier as "shared" | "dedicatedNodes" | "dedicatedCluster" } : {}),
        ...(opts.compute ? { compute: _buildComputeBody(opts.compute, opts.nodePool) } : {}),
        ...(Object.keys(quota).length > 0 ? { resources: { quota } } : {}),
      };

      // 2. PUT through the generated client; a tier change is re-gated server-side.
      //    The update body is typed as an open object in the contract, so the
      //    assembled partial is forwarded as-is for the API to validate.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/cluster-tenants/{name}", { params: { path: { name } }, body: body as Record<string, never> });

      // 3. Surface any API error (e.g. 422 TIER_UNAVAILABLE) as a clean message.
      if (error) _PrintApiError("cluster-tenant update", error);
      _Print(data, opts.output);
    });

  clusterTenant
    .command("delete <name>")
    .description("Delete a cluster tenant")
    .action(async function _delete(name: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/cluster-tenants/{name}", { params: { path: { name } } });
      if (error) _PrintApiError("cluster-tenant delete", error);
      _PrintSuccess(`Cluster tenant "${name}" deleted`);
    });
}
