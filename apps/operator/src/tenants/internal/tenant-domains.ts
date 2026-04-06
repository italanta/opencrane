/**
 * Encapsulates tenant domain and hostname conventions.
 */
export class TenantDomains
{
  /** Base ingress domain (for example: opencrane.local). */
  private ingressDomain: string;

  /**
   * Create a domain helper for tenant host generation.
   */
  constructor(ingressDomain: string)
  {
    this.ingressDomain = ingressDomain;
  }

  /**
   * Build the fully-qualified hostname for a tenant.
   */
  buildIngressHost(tenantName: string): string
  {
    return `${tenantName}.${this.ingressDomain}`;
  }
}
