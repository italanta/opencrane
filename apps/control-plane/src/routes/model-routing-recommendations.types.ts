/**
 * Route-local types for the savings-recommendation feed (AIR.11). The wire shape
 * (`SavingsRecommendation`) lives in `@opencrane/contracts`; this file carries only the internal
 * scope view used to fail-closed filter the result set for a non-operator caller.
 */

/**
 * The caller's resolved authorization scope for read-time result filtering (AIR.11). A platform
 * operator sees every skill's recommendation; a non-operator sees only the skills owned by their
 * own ClusterTenant (a skill's owner = its team). Fail-closed: a non-operator with no resolved
 * ClusterTenant sees nothing.
 */
export interface CallerScope
{
  /** True when the caller is a platform operator (sees all). */
  isOperator: boolean;
  /** The caller's own ClusterTenant ref when resolved; null when unresolved/ambiguous. */
  clusterTenant: string | null;
}
