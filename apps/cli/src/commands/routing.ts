import type { Command } from "commander";

import type { RoutingEvalCaseWrite } from "@opencrane/contracts";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

/** Columns shown for `oc routing eval-case list` in table mode. */
const _EVAL_CASE_COLUMNS = ["id", "skillName", "skillScope", "skillTeam", "qualityBar", "input", "expected"];

/** Columns shown for `oc routing measurement list` in table mode. */
const _MEASUREMENT_COLUMNS = [
  "id",
  "skillName",
  "skillScope",
  "skillTeam",
  "candidateModel",
  "sampledCalls",
  "projectedSavingsPct",
  "ciLowPct",
  "ciHighPct",
];

/** Columns shown for `oc routing proposal list` in table mode. */
const _PROPOSAL_COLUMNS = [
  "id",
  "skillName",
  "skillScope",
  "skillTeam",
  "fromModel",
  "proposedModel",
  "projectedSavingsPct",
  "status",
];

/** Columns shown for `oc routing recommendation list` in table mode. */
const _RECOMMENDATION_COLUMNS = [
  "skillName",
  "modelMode",
  "currentModel",
  "recommendedModel",
  "projectedSavingsPct",
  "hasOpenProposal",
];

/** Filter flags shared by the eval-case and measurement list commands. */
interface _SkillFilterOptions
{
  /** Filter to one owning skill name. */
  skillName?: string;
  /** Filter to one owning skill scope. */
  skillScope?: string;
  /** Filter to one owning skill team. */
  skillTeam?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc routing eval-case add` / `update`. */
interface _EvalCaseWriteOptions
{
  /** Owning skill name. */
  skillName?: string;
  /** Owning skill scope. */
  skillScope?: string;
  /** Owning skill team (defaults to empty server-side). */
  skillTeam?: string;
  /** The prompt/inputs for this case as a JSON string (parsed with JSON.parse). */
  input?: string;
  /** Optional golden answer or grader rubric as a JSON string (parsed with JSON.parse). */
  expected?: string;
  /** Minimum judge score (0..1); defaults to 0.8 server-side. */
  qualityBar?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc routing measurement run`. */
interface _MeasurementRunOptions
{
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team (defaults to empty server-side). */
  skillTeam?: string;
  /** The cheaper candidate model's publicModelName to evaluate. */
  candidateModel: string;
  /** Baseline model; resolved from the skill's pin when omitted. */
  currentModel?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc routing proposal list`. */
interface _ProposalListOptions
{
  /** Filter by lifecycle status. */
  status?: "pending" | "approved" | "rejected" | "applied";
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc routing recommendation list`. */
interface _RecommendationListOptions
{
  /** Filter to skills owned by this ClusterTenant. */
  clusterTenant?: string;
  /** Filter to one owning skill scope. */
  skillScope?: string;
  /** When set, return only skills with an open Pending proposal. */
  onlyOpen?: boolean;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc routing metrics`. */
interface _MetricsOptions
{
  /** Langfuse v1 metrics query as a JSON string (parsed + re-stringified before forwarding). */
  query?: string;
  /** Output format. */
  output: OutputFormat;
}

/**
 * Parse a JSON-valued flag (`--input` / `--expected`) into an arbitrary value.
 * Exits cleanly on malformed JSON so the caller never sees a raw exception.
 *
 * @param flag - Flag name for the error message, e.g. `--input`.
 * @param raw  - Raw JSON string from the flag.
 */
function _parseJsonFlag(flag: string, raw: string): unknown
{
  try
  {
    return JSON.parse(raw);
  }
  catch (err)
  {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${flag} is not valid JSON — ${msg}`);
    process.exit(1);
  }
}

/** Build the shared skill-filter query object from list flags. */
function _skillFilterQuery(opts: _SkillFilterOptions): Record<string, string>
{
  return {
    ...(opts.skillName ? { skillName: opts.skillName } : {}),
    ...(opts.skillScope ? { skillScope: opts.skillScope } : {}),
    ...(opts.skillTeam ? { skillTeam: opts.skillTeam } : {}),
  };
}

/** Register the `oc routing eval-case *` sub-commands on the given parent. */
function _registerEvalCase(parent: Command, getConfig: () => CliConfig): void
{
  const evalCase = parent
    .command("eval-case")
    .description("Manage golden eval cases graded against a skill's quality bar (list, show, add, update, remove)");

  evalCase
    .command("list")
    .description("List routing eval cases, optionally filtered by skill")
    .option("--skill-name <name>", "Filter to one owning skill name")
    .option("--skill-scope <scope>", "Filter to one owning skill scope")
    .option("--skill-team <team>", "Filter to one owning skill team")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _SkillFilterOptions)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/eval-cases", {
        params: { query: _skillFilterQuery(opts) },
      });
      if (error) _PrintApiError("routing eval-case list", error);
      _Print(data, opts.output, _EVAL_CASE_COLUMNS);
    });

  evalCase
    .command("show <id>")
    .description("Show a single routing eval case by id")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/eval-cases/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("routing eval-case show", error);
      _Print(data, opts.output);
    });

  evalCase
    .command("add")
    .description("Create a routing eval case for a skill")
    .requiredOption("--skill-name <name>", "Owning skill name")
    .requiredOption("--skill-scope <scope>", "Owning skill scope, e.g. org|team|personal")
    .option("--skill-team <team>", "Owning skill team (defaults to empty)")
    .requiredOption("--input <json>", "Prompt/inputs for this case as a JSON value")
    .option("--expected <json>", "Golden answer or grader rubric as a JSON value")
    .option("--quality-bar <score>", "Minimum judge score 0..1 (defaults to 0.8)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _add(opts: _EvalCaseWriteOptions)
    {
      // 1. Assemble the typed write body from the supplied flags. JSON-valued
      //    fields are parsed here; everything else passes through verbatim so
      //    the API stays the single validator.
      const body: RoutingEvalCaseWrite = {
        skillName: opts.skillName as string,
        skillScope: opts.skillScope as string,
        ...(opts.skillTeam !== undefined ? { skillTeam: opts.skillTeam } : {}),
        input: _parseJsonFlag("--input", opts.input as string),
        ...(opts.expected !== undefined ? { expected: _parseJsonFlag("--expected", opts.expected) } : {}),
        ...(opts.qualityBar !== undefined ? { qualityBar: Number(opts.qualityBar) } : {}),
      };

      // 2. POST through the generated client.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/model-routing/eval-cases", { body });
      if (error) _PrintApiError("routing eval-case add", error);
      _Print(data, opts.output);
    });

  evalCase
    .command("update <id>")
    .description("Update a routing eval case by id")
    .requiredOption("--skill-name <name>", "Owning skill name")
    .requiredOption("--skill-scope <scope>", "Owning skill scope, e.g. org|team|personal")
    .option("--skill-team <team>", "Owning skill team (defaults to empty)")
    .requiredOption("--input <json>", "Prompt/inputs for this case as a JSON value")
    .option("--expected <json>", "Golden answer or grader rubric as a JSON value")
    .option("--quality-bar <score>", "Minimum judge score 0..1 (defaults to 0.8)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _update(id: string, opts: _EvalCaseWriteOptions)
    {
      // 1. Assemble the typed write body — same shape as `add`.
      const body: RoutingEvalCaseWrite = {
        skillName: opts.skillName as string,
        skillScope: opts.skillScope as string,
        ...(opts.skillTeam !== undefined ? { skillTeam: opts.skillTeam } : {}),
        input: _parseJsonFlag("--input", opts.input as string),
        ...(opts.expected !== undefined ? { expected: _parseJsonFlag("--expected", opts.expected) } : {}),
        ...(opts.qualityBar !== undefined ? { qualityBar: Number(opts.qualityBar) } : {}),
      };

      // 2. PUT through the generated client.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/model-routing/eval-cases/{id}", { params: { path: { id } }, body });
      if (error) _PrintApiError("routing eval-case update", error);
      _Print(data, opts.output);
    });

  evalCase
    .command("remove <id>")
    .description("Delete a routing eval case by id")
    .action(async function _remove(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/model-routing/eval-cases/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("routing eval-case remove", error);
      _PrintSuccess(`Routing eval case "${id}" removed`);
    });
}

/** Register the `oc routing measurement *` sub-commands on the given parent. */
function _registerMeasurement(parent: Command, getConfig: () => CliConfig): void
{
  const measurement = parent
    .command("measurement")
    .description("Manage shadow-savings measurements for a skill + candidate model (list, show, run)");

  measurement
    .command("list")
    .description("List shadow-savings measurements, optionally filtered by skill")
    .option("--skill-name <name>", "Filter to one owning skill name")
    .option("--skill-scope <scope>", "Filter to one owning skill scope")
    .option("--skill-team <team>", "Filter to one owning skill team")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _SkillFilterOptions)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/measurements", {
        params: { query: _skillFilterQuery(opts) },
      });
      if (error) _PrintApiError("routing measurement list", error);
      _Print(data, opts.output, _MEASUREMENT_COLUMNS);
    });

  measurement
    .command("show <id>")
    .description("Show a single measurement by id")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/measurements/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("routing measurement show", error);
      _Print(data, opts.output);
    });

  measurement
    .command("run")
    .description("Trigger a shadow-savings measurement for a skill + candidate (operator-gated, best-effort)")
    .requiredOption("--skill-name <name>", "Owning skill name")
    .requiredOption("--skill-scope <scope>", "Owning skill scope, e.g. org|team|personal")
    .option("--skill-team <team>", "Owning skill team (defaults to empty)")
    .requiredOption("--candidate-model <publicModelName>", "The cheaper candidate model's public slug")
    .option("--current-model <publicModelName>", "Baseline model (resolved from the skill's pin when omitted)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _run(opts: _MeasurementRunOptions)
    {
      // 1. Assemble the typed run body from the supplied flags.
      const body = {
        skillName: opts.skillName,
        skillScope: opts.skillScope,
        ...(opts.skillTeam !== undefined ? { skillTeam: opts.skillTeam } : {}),
        candidateModel: opts.candidateModel,
        ...(opts.currentModel !== undefined ? { currentModel: opts.currentModel } : {}),
      };

      // 2. POST /run — returns 200 {status:"unconfigured"} or 202 {status:"measured", ...}.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/model-routing/measurements/run", { body });
      if (error) _PrintApiError("routing measurement run", error);
      _Print(data, opts.output);
    });
}

/** Register the `oc routing proposal *` sub-commands on the given parent. */
function _registerProposal(parent: Command, getConfig: () => CliConfig): void
{
  const proposal = parent
    .command("proposal")
    .description("Manage human-gated routing-change proposals (list, show, approve, reject)");

  proposal
    .command("list")
    .description("List routing-change proposals, optionally filtered by status")
    .option("--status <status>", "Filter by lifecycle status: pending|approved|rejected|applied")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _ProposalListOptions)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/proposals", {
        params: { query: opts.status ? { status: opts.status } : {} },
      });
      if (error) _PrintApiError("routing proposal list", error);
      _Print(data, opts.output, _PROPOSAL_COLUMNS);
    });

  proposal
    .command("show <id>")
    .description("Show a single proposal by id")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/proposals/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("routing proposal show", error);
      _Print(data, opts.output);
    });

  proposal
    .command("approve <id>")
    .description("Approve a proposal — pin the skill to the proposed model and mark it Applied")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _approve(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/model-routing/proposals/{id}/approve", { params: { path: { id } } });
      if (error) _PrintApiError("routing proposal approve", error);
      _Print(data, opts.output);
    });

  proposal
    .command("reject <id>")
    .description("Reject a proposal — flip status to Rejected; the skill posture is untouched")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _reject(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/model-routing/proposals/{id}/reject", { params: { path: { id } } });
      if (error) _PrintApiError("routing proposal reject", error);
      _Print(data, opts.output);
    });
}

/** Register the `oc routing recommendation *` sub-commands on the given parent. */
function _registerRecommendation(parent: Command, getConfig: () => CliConfig): void
{
  const recommendation = parent
    .command("recommendation")
    .description("Inspect ranked savings recommendations derived from shadow measurements (AIR.10)");

  recommendation
    .command("list")
    .description("List savings recommendations, sorted by projected savings desc")
    .option("--cluster-tenant <id>", "Filter to skills owned by this cluster tenant")
    .option("--skill-scope <scope>", "Filter to one owning skill scope")
    .option("--only-open", "Return only skills with an open Pending proposal")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _RecommendationListOptions)
    {
      const query = {
        ...(opts.clusterTenant ? { clusterTenant: opts.clusterTenant } : {}),
        ...(opts.skillScope ? { skillScope: opts.skillScope } : {}),
        ...(opts.onlyOpen ? { onlyOpen: "true" as const } : {}),
      };
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/recommendations", { params: { query } });
      if (error) _PrintApiError("routing recommendation list", error);
      _Print(data, opts.output, _RECOMMENDATION_COLUMNS);
    });
}

/** Register the `oc routing metrics` sub-command on the given parent. */
function _registerMetrics(parent: Command, getConfig: () => CliConfig): void
{
  parent
    .command("metrics")
    .description("Fetch Langfuse v1 routing metrics (loosely-typed passthrough; may return unconfigured) (AIR.11)")
    .option("--query <json>", "Langfuse v1 metrics query as a JSON object string")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _metrics(opts: _MetricsOptions)
    {
      // The endpoint expects a `query` string; validate + normalise the supplied
      // JSON here so a malformed value fails cleanly before the request goes out.
      const query = opts.query !== undefined
        ? { query: JSON.stringify(_parseJsonFlag("--query", opts.query)) }
        : {};
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/model-routing/metrics", { params: { query } });
      if (error) _PrintApiError("routing metrics", error);
      _Print(data, opts.output);
    });
}

/** Register all `oc routing *` sub-commands on the given parent Command. */
export function _RegisterRouting(parent: Command, getConfig: () => CliConfig): void
{
  const routing = parent
    .command("routing")
    .description("Manage model-routing eval cases, shadow-savings measurements, proposals, recommendations, and metrics (AIR.6/7/10/11)");

  _registerEvalCase(routing, getConfig);
  _registerMeasurement(routing, getConfig);
  _registerProposal(routing, getConfig);
  _registerRecommendation(routing, getConfig);
  _registerMetrics(routing, getConfig);
}
