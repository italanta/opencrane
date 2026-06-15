/**
 * Build the fully-qualified ingress hostname for a UserTenant gateway:
 * `<tenantName>.<ingressDomain>`, where `ingressDomain` is the ClusterTenant base
 * domain. So the host is a per-user UserTenant gateway under the customer's
 * (ClusterTenant's) own domain — e.g. `mike.ai.client-company.com`. See
 * docs/agents/cluster-architecture.md → "Tenancy Model — ClusterTenant vs UserTenant".
 */
export function _BuildIngressHost(tenantName: string, ingressDomain: string): string
{
  return `${tenantName}.${ingressDomain}`;
}