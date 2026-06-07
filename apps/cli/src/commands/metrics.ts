import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, type OutputFormat } from "../format.js";

/** Register all `oc metrics *` sub-commands on the given parent Command. */
export function _RegisterMetrics(parent: Command, getConfig: () => CliConfig): void
{
  const metrics = parent
    .command("metrics")
    .description("Inspect server utilisation and projection drift metrics");

  metrics
    .command("server")
    .description("Get latest server utilisation snapshot (CPU, memory, storage, active tenants)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _server(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/metrics/server");
      if (error) _PrintApiError("metrics server", error);
      _Print(data, opts.output, ["cpuPercent", "memoryUsedBytes", "memoryTotalBytes", "activeTenants", "sampledAt"]);
    });

  metrics
    .command("drift")
    .description("Get projection drift metrics (detect-only: Tenant and AccessPolicy resource sync state)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _drift(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/metrics/projection-drift");
      if (error) _PrintApiError("metrics drift", error);
      _Print(data, opts.output);
    });
}
