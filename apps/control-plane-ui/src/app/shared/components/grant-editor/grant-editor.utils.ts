import { GrantAccess, GrantScope, GrantSubjectType } from "../../../core/models/grant.model";

/** Read the current value from a native select change event. */
export function _ReadSelectValue(event: Event): string
{
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}

/** Read the current value from a native text input event. */
export function _ReadInputValue(event: Event): string
{
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

/** Create a stable-enough local identifier for preview-only grants. */
export function _CreateGrantId(subjectType: GrantSubjectType, subjectName: string, scope: GrantScope, access: GrantAccess): string
{
  const normalizedName = subjectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${scope}-${subjectType}-${normalizedName || "grant"}-${access}-${Date.now()}`;
}
