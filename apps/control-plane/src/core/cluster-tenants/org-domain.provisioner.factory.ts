import type * as k8s from "@kubernetes/client-node";

import { CertManagerClient } from "./cert-manager.client.js";
import { CloudDnsClient } from "./cloud-dns.client.js";
import { DefaultOrgDomainProvisioner } from "./org-domain.provisioner.js";
import type { OrgDomainProvisioner } from "./org-domain-provisioner.types.js";

/**
 * Build the concrete {@link OrgDomainProvisioner} from the environment, wiring the
 * real cert-manager (custom-objects) and Cloud DNS clients.
 *
 * Env (all optional; sensible defaults match the chart values):
 * - `GCP_PROJECT_ID`           — project owning the Cloud DNS managed zone (required for DNS).
 * - `DNS_MANAGED_ZONE`         — managed-zone resource name (terraform `<zone>-zone`); required for DNS.
 * - `CERT_MANAGER_ISSUER_NAME` — issuer the Certificate references (default `opencrane-issuer`).
 * - `CERT_MANAGER_ISSUER_KIND` — `ClusterIssuer` (default) or `Issuer`.
 * - `CLUSTER_TENANT_NAMESPACE_PREFIX` — org→namespace prefix (default `opencrane-`).
 *
 * Returns null when the DNS coordinates are absent (no GCP project/zone) — the
 * platform is not on a Cloud DNS install, so per-org domain provisioning is
 * unavailable and the reconciler must treat the org as not-yet-served (fail-closed),
 * NOT silently succeed.
 *
 * @param customApi - Kubernetes custom-objects client (Certificate CRDs).
 * @returns A wired provisioner, or null when Cloud DNS coordinates are unset.
 */
export function _BuildOrgDomainProvisioner(customApi: k8s.CustomObjectsApi): OrgDomainProvisioner | null
{
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const managedZone = process.env.DNS_MANAGED_ZONE?.trim();
  if (!projectId || !managedZone)
  {
    return null;
  }

  const issuerName = process.env.CERT_MANAGER_ISSUER_NAME?.trim() || "opencrane-issuer";
  const issuerKind = process.env.CERT_MANAGER_ISSUER_KIND?.trim() === "Issuer" ? "Issuer" : "ClusterIssuer";
  const namespacePrefix = process.env.CLUSTER_TENANT_NAMESPACE_PREFIX?.trim() || "opencrane-";

  return new DefaultOrgDomainProvisioner(
    new CertManagerClient(customApi),
    new CloudDnsClient(projectId, managedZone),
    { issuerName, issuerKind, namespacePrefix },
  );
}
