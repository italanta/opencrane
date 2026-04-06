/**
 * Build the fully-qualified ingress hostname for a tenant.
 */
export function _BuildIngressHost(tenantName: string, ingressDomain: string): string
{
  return `${tenantName}.${ingressDomain}`;
}