/**
 * Route-local types for the routing measurements API (AIR.6). The `RoutingMeasurement` DTO is owned
 * by `@opencrane/contracts`; this file carries the `POST /run` request body and validation envelope.
 */

/** Request body for `POST /run` — trigger a shadow measurement for one skill + candidate. */
export interface RunMeasurementBody
{
  /** Owning skill name. */
  skillName: string;
  /** Owning skill scope. */
  skillScope: string;
  /** Owning skill team (defaults to empty). */
  skillTeam?: string;
  /** The cheaper candidate model to evaluate against the skill's current default. */
  candidateModel: string;
  /** The current/default model to use as the baseline; resolved by the caller (optional). */
  currentModel?: string | null;
}

/** A `{ error, code }` validation-failure envelope, matching the platform's error convention. */
export interface ValidationFailure
{
  /** Human-readable failure reason. */
  error: string;
  /** Stable machine-readable code. */
  code: string;
}
