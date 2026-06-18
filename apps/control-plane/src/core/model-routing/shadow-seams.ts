import type { JudgeClient, ModelRunner } from "./shadow-measure.types.js";

/**
 * Resolve the shadow-measurement runtime seams from the environment (AIR.6).
 *
 * This is the single plug-point where a **live** model runner + vendor-neutral judge would be
 * constructed. Today it is an explicit seam: live ML integration (LiteLLM candidate execution
 * against logged traffic, an injected judge model, Langfuse ingestion) is intentionally NOT built
 * in this TypeScript core. With no `LITELLM_ENDPOINT` configured, both seams resolve to null and
 * `_RunShadowMeasurement` becomes a no-op — the validatable wiring stays intact without live infra.
 *
 * A live implementation lands here: build a `ModelRunner` that calls `LITELLM_ENDPOINT` and reads
 * cost from the usage callback, and a `JudgeClient` backed by a fixed, independent judge model
 * (read from a dedicated `ROUTING_JUDGE_MODEL` env — never the routed candidate's family).
 *
 * @returns The `{ judge, runner }` pair; both null when the seams are unconfigured.
 */
export function _BuildShadowSeams(): { judge: JudgeClient | null; runner: ModelRunner | null }
{
  const endpoint = process.env.LITELLM_ENDPOINT?.trim() ?? "";

  // Unconfigured: no live LiteLLM endpoint means no candidate execution and no judge. Return the
  // null pair so the orchestrator records nothing and never throws (best-effort posture).
  if (!endpoint)
  {
    return { judge: null, runner: null };
  }

  // Seam boundary: a live runner/judge would be constructed here. Until the live ML integration
  // lands, treat a configured endpoint without an explicit judge model as still-unconfigured so we
  // never grade a candidate with a same-family judge (the vendor-neutrality rule).
  const judgeModel = process.env.ROUTING_JUDGE_MODEL?.trim() ?? "";
  if (!judgeModel)
  {
    return { judge: null, runner: null };
  }

  // Live wiring is out of scope for the validatable core (see this function's JSDoc). Returning the
  // null pair keeps the contract honest: the seam exists and is documented, but is not faked here.
  return { judge: null, runner: null };
}
