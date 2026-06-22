import type * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import { CertManagerClient } from "./cert-manager.client.js";
import { DefaultOrgDomainProvisioner } from "./org-domain.provisioner.js";
import type { OrgDomainProvisioner } from "./org-domain-provisioner.types.js";

/**
 * Build the concrete {@link OrgDomainProvisioner} from the operator config, wiring the
 * real cert-manager custom-objects client.
 *
 * The client detects an absent Certificate CRD at runtime (fail-closed) rather than at
 * construction, so a cluster without cert-manager still gets a real provisioner that
 * skips the (vanity-only) cert side gracefully. There is no DNS client: every org host
 * `<org>.<base>` is covered by the platform `*.<base>` record, and a customer-vanity
 * domain is the customer's own CNAME — so the operator declares no DNS records.
 *
 * @param customApi - Kubernetes custom-objects client (the Certificate CRD).
 * @param config - Operator runtime configuration.
 * @returns A wired provisioner.
 */
export function _BuildOrgDomainProvisioner(customApi: k8s.CustomObjectsApi, config: OpenClawTenantOperatorConfig): OrgDomainProvisioner
{
  return new DefaultOrgDomainProvisioner(
    new CertManagerClient(customApi),
    {
      issuerName: config.certManagerIssuerName,
      issuerKind: config.certManagerIssuerKind,
    },
  );
}
