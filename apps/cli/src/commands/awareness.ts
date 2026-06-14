import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Columns shown for the rollout state in table output. */
const _ROLLOUT_COLUMNS = ["targetVersion", "stableVersion", "promotedWaves", "nextWave", "shadowMode"];

/** Register all `oc awareness *` sub-commands on the given parent Command. */
export function _RegisterAwareness(parent: Command, getConfig: () => CliConfig): void
{
  const awareness = parent
    .command("awareness")
    .description("Manage fleet awareness (contract rollout)");

  const rollout = awareness
    .command("rollout")
    .description("Manage the awareness contract canary rollout (show, set, promote, rollback, resolve)");

  rollout
    .command("show")
    .description("Show the current rollout state and next wave")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/awareness/rollout");
      if (error) _PrintApiError("awareness rollout show", error);
      _Print(data, opts.output, _ROLLOUT_COLUMNS);
    });

  rollout
    .command("set <targetVersion>")
    .description("Define (or redefine) the rollout target; resets the promotion frontier")
    .option("--stable <version>", "Stable version for un-promoted waves (defaults to the SDK's pinned version)")
    .option("--waves <csv>", "Comma-separated canary waves (narrow→wide)")
    .option("--shadow", "Promoted waves compute the target but still serve stable", false)
    .action(async function _set(targetVersion: string, opts: { stable?: string; waves?: string; shadow: boolean })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/awareness/rollout", {
        body: {
          targetVersion,
          stableVersion: opts.stable,
          waves: opts.waves ? opts.waves.split(",").map(function _trim(w) { return w.trim(); }).filter(Boolean) : undefined,
          shadowMode: opts.shadow,
        },
      });
      if (error) _PrintApiError("awareness rollout set", error);
      _PrintSuccess(`Rollout target set to "${targetVersion}"`);
      _Print(data, "json");
    });

  rollout
    .command("promote")
    .description("Advance the rollout frontier — one wave, or up to a named wave")
    .option("--wave <wave>", "Promote up to and including this wave")
    .action(async function _promote(opts: { wave?: string })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/awareness/rollout/promote", {
        body: opts.wave ? { wave: opts.wave } : {},
      });
      if (error) _PrintApiError("awareness rollout promote", error);
      _PrintSuccess(opts.wave ? `Promoted up to wave "${opts.wave}"` : "Advanced to the next wave");
      _Print(data, "json");
    });

  rollout
    .command("rollback")
    .description("One-step rollback: return every wave to the stable version")
    .action(async function _rollback()
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/awareness/rollout/rollback", {});
      if (error) _PrintApiError("awareness rollout rollback", error);
      _PrintSuccess("Rolled back — all waves on the stable version");
      _Print(data, "json");
    });

  rollout
    .command("resolve <tenant>")
    .description("Resolve the awareness contract version a tenant runs")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _resolve(tenant: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/awareness/rollout/resolve/{tenant}", {
        params: { path: { tenant } },
      });
      if (error) _PrintApiError("awareness rollout resolve", error);
      _Print(data, opts.output, ["tenant", "version", "promoted", "shadow", "wave"]);
    });

  awareness
    .command("participation")
    .description("Fleet participation monitoring (drift + policy-violation severity)")
    .option("--severity <severity>", "Filter the tenant list: critical|warning")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _participation(opts: { severity?: "critical" | "warning"; output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/awareness/participation", {
        params: { query: opts.severity ? { severity: opts.severity } : {} },
      });
      if (error) _PrintApiError("awareness participation", error);
      // Tabular view lists per-tenant rows; the aggregate counts are in JSON output.
      const rows = data && typeof data === "object" && Array.isArray((data as { tenants?: unknown[] }).tenants)
        ? (data as { tenants: unknown[] }).tenants
        : data;
      _Print(rows, opts.output, ["tenant", "participating", "drifted", "policyViolations", "severity", "runningContractVersion", "expectedContractVersion"]);
    });
}
