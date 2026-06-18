/**
 * Types + seam interfaces for the AIR.6 shadow-measurement orchestrator.
 *
 * The orchestrator wires the pure savings estimator to persistence and to two injected runtime
 * seams. The seams are deliberately narrow and vendor-neutral so a live implementation (LiteLLM
 * runner, an injected judge model, Langfuse-sourced traffic) plugs in without touching the loop.
 */

import type { RoutingEvalCase } from "@prisma/client";

/**
 * Vendor-neutral judge seam: scores a model output against an eval case, 0..1.
 *
 * The judge model MUST be injected and MUST NOT be hardcoded to the routed model family — grading a
 * candidate with a sibling of the candidate biases the measurement. A live implementation points
 * this at a fixed, independent judge model (or an LLM-as-judge over a rubric).
 */
export interface JudgeClient
{
  /**
   * Score one output against the case's expected answer/rubric.
   * @param input    - The eval case input.
   * @param output   - The model output to grade.
   * @param expected - The golden answer or rubric (may be null).
   * @returns A quality score in [0, 1].
   */
  score(input: unknown, output: unknown, expected: unknown): Promise<number>;
}

/** The output + cost of running a model on one input. */
export interface ModelRunResult
{
  /** The raw model output, passed verbatim to the judge. */
  output: unknown;
  /** The USD cost of this single run, used by the savings estimator. */
  costUsd: number;
}

/**
 * Model-runner seam: executes a model on an input and reports its output + cost.
 *
 * A live implementation calls the LiteLLM endpoint (and reads cost from the usage callback). The
 * orchestrator runs both baseline and candidate through the same runner so costs are comparable.
 */
export interface ModelRunner
{
  /**
   * Run a model on one input.
   * @param model - The model `publicModelName` to run.
   * @param input - The eval case input.
   * @returns The output and its USD cost.
   */
  run(model: string, input: unknown): Promise<ModelRunResult>;
}

/** Identity of the skill a measurement targets (its loose compound key). */
export interface ShadowSkillRef
{
  /** Skill name. */
  name: string;
  /** Skill scope. */
  scope: string;
  /** Owning team (empty string for org/global). */
  team: string;
}

/** Inputs for one shadow-measurement run (AIR.6). */
export interface ShadowMeasureInput
{
  /** The skill being measured. */
  skill: ShadowSkillRef;
  /** The eval cases to grade both models against. */
  evalCases: readonly RoutingEvalCase[];
  /** The current/default model the skill resolves to (the baseline; null when unset). */
  currentModel: string | null;
  /** The cheaper candidate model to evaluate. */
  candidateModel: string;
}

/** The persisted outcome of a shadow-measurement run. */
export interface ShadowMeasureOutcome
{
  /** `"measured"` when seams ran and a measurement was persisted; `"unconfigured"` is a no-op. */
  kind: "measured" | "unconfigured";
  /** The persisted measurement id, when `kind` is `measured`. */
  measurementId?: string;
  /** The persisted proposal id, present only when the savings CI excluded zero. */
  proposalId?: string;
}
