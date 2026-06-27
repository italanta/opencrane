/**
 * Derive the ClusterTenant (silo) the caller is currently on from the request host. Each org is
 * served at `<clusterTenant>.<base>`, so the first DNS label names the silo (port and case are
 * stripped). Returns undefined for a bare host with no subdomain (e.g. localhost) so the caller
 * falls back to an unscoped lookup. The label is only a candidate: the email→tenant query filters
 * on it and yields zero rows for a host whose first label is not a real silo, so a wrong guess
 * fail-closes rather than mis-resolving. Custom org domains that do not follow `<org>.<base>` are
 * not matched here (a future ingressHost-based lookup would cover them).
 *
 * The generic `_RequestHost` helper now lives in `@opencrane/infra-auth`; this silo-specific
 * label-extraction stays here.
 *
 * @param host - The request host, typically from `_RequestHost`.
 * @returns The silo (first DNS label), or undefined when none can be derived.
 */
export function _ClusterTenantFromHost(host: string | undefined): string | undefined
{
  if (!host) return undefined;
  const firstLabel = host.split(":")[0].trim().toLowerCase().split(".")[0];
  return firstLabel || undefined;
}
