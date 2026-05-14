/**
 * Single repair action taken on one projection row during a repair run.
 */
export interface ProjectionRepairEntry
{
  /** Resource name that was inspected. */
  name: string;

  /**
   * Outcome for this resource.
   * - `created`: projection row was missing and has been inserted from CRD state.
   * - `updated`: projection row existed but had field drift and has been corrected.
   * - `skipped`: resource is in a state repair does not touch (e.g. missing CRD source).
   */
  action: "created" | "updated" | "skipped";

  /** Human-readable reason for the action taken. */
  reason: string;

  /** When true the action was simulated only; no database writes were performed. */
  dryRun: boolean;
}

/**
 * Summary payload returned by a projection repair run.
 */
export interface ProjectionRepairReport
{
  /** Entity family that was repaired. */
  resource: "Tenant" | "AccessPolicy";

  /** Whether this report reflects real writes or a simulation. */
  mode: "dry-run" | "apply";

  /** Total number of resources that were created or updated. */
  repairedCount: number;

  /** Total number of resources that were deliberately skipped. */
  skippedCount: number;

  /** Per-resource detail of every action taken or simulated. */
  entries: ProjectionRepairEntry[];
}
