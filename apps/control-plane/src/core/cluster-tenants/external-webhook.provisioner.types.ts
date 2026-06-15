/**
 * Connection settings for the external webhook provisioner, resolved from the
 * environment. Carries the HTTPS endpoint, bearer token, and the stable
 * identifier the backend advertises in the provisioner registry.
 */
export interface ExternalWebhookProvisionerConfig
{
  /** HTTPS endpoint the provision request is POSTed to. */
  url: string;
  /** Bearer token presented to the external backend (compatibility shim; IAM-first preferred). */
  token: string;
  /** Stable identifier advertised by this provisioner in the registry. */
  id: string;
}
