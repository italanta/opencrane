/**
 * Return the standard set of labels applied to all tenant-owned resources.
 */
export function _BuildTenantLabels(name: string): Record<string, string>
{
  return {
    "app.kubernetes.io/part-of": "opencrane",
    "app.kubernetes.io/component": "tenant",
    "app.kubernetes.io/managed-by": "opencrane-operator",
    "opencrane.io/tenant": name,
  };
}