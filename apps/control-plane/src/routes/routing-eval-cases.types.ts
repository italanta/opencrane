/**
 * Route-local types for the routing eval-cases API (AIR.6). The DTO vocabulary
 * (`RoutingEvalCase`, `RoutingEvalCaseWrite`) is owned by `@opencrane/contracts`; this file carries
 * only the validation envelope used by the eval-case endpoints.
 */

/** A `{ error, code }` validation-failure envelope, matching the platform's error convention. */
export interface ValidationFailure
{
  /** Human-readable failure reason. */
  error: string;
  /** Stable machine-readable code. */
  code: string;
}
