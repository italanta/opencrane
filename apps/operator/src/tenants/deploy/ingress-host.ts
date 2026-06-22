/**
 * Build the fully-qualified ingress hostname for a UserTenant gateway:
 * `<tenantName>.<ingressDomain>`. Under the fixed-wildcard topology `ingressDomain`
 * is the org's serving domain `<org>.<base>` (so the user lands at
 * `<user>.<org>.<base>`, e.g. `mike.acme.weownai.eu`), or a customer-vanity domain
 * CNAMEd onto that apex; ref-less openclaws fall back to the bare platform base
 * `<base>`. See docs/agents/cluster-architecture.md → "Tenancy Model".
 */
export function _BuildIngressHost(tenantName: string, ingressDomain: string): string
{
  return `${tenantName}.${ingressDomain}`;
}