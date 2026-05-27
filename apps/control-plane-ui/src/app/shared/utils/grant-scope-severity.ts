import { GrantScope } from "../../core/models/grant.model";

/** PrimeNG severities used for grant scope badges. */
export type GrantScopeSeverity = "info" | "warn" | "success" | "secondary";

/**
 * Map a grant scope to the PrimeNG tag severity used across entitlement views.
 *
 * @param scope - Grant scope displayed in the UI.
 * @returns Consistent severity token for the scope badge.
 */
export function getGrantScopeSeverity(scope: GrantScope): GrantScopeSeverity
{
  switch (scope)
  {
    case GrantScope.Org:
      return "info";
    case GrantScope.Department:
      return "warn";
    case GrantScope.Project:
      return "success";
    default:
      return "secondary";
  }
}
