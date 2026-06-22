import type * as k8s from "@kubernetes/client-node";

import { _IsConflict, _IsCrdAbsent, _IsNotFound } from "./k8s-api-errors.js";
import type { DnsEndpointOperations, DnsEndpointReadiness } from "./org-domain-provisioner.types.js";

/** external-dns API group for the DNSEndpoint custom resource. */
const _ED_GROUP = "externaldns.k8s.io";
/** external-dns API version for the DNSEndpoint custom resource. */
const _ED_VERSION = "v1alpha1";
/** Plural for the namespaced `DNSEndpoint` custom resource. */
const _ED_DNSENDPOINT_PLURAL = "dnsendpoints";

/**
 * Production external-dns client over the operator's Kubernetes custom-objects API.
 *
 * The operator does NOT talk to any cloud DNS API directly: it declares the desired
 * per-org records as a namespaced `DNSEndpoint` custom resource, and the external-dns
 * controller (run with `--source=crd`) reconciles them into whatever DNS provider the
 * platform is configured for (Cloud DNS, Route53, Cloudflare, RFC2136, …). This keeps
 * the operator provider-agnostic and free of any cloud SDK, and gives automatic
 * record cleanup when the DNSEndpoint (or its namespace) is deleted.
 *
 * Same create-then-replace-on-409 + fail-closed-on-absent-CRD posture as
 * {@link CertManagerClient}: when external-dns is not installed (the DNSEndpoint CRD is
 * not served) apply does NOT crash — it returns `applied: false` so the provisioner can
 * surface a clear skip. The manifest IS genuinely built and the API call IS issued; only
 * an absent CRD short-circuits it.
 */
export class DnsEndpointClient implements DnsEndpointOperations
{
  /** Kubernetes custom-objects client (DNSEndpoint CRDs). */
  private readonly customApi: k8s.CustomObjectsApi;

  /**
   * @param customApi - Kubernetes custom-objects client.
   */
  public constructor(customApi: k8s.CustomObjectsApi)
  {
    this.customApi = customApi;
  }

  /** @inheritdoc */
  public async applyDnsEndpoint(namespace: string, manifest: Record<string, unknown>): Promise<DnsEndpointReadiness>
  {
    const name = ((manifest.metadata as Record<string, unknown>)?.name) as string;

    try
    {
      // 1. Create first — the common path on a fresh org. A 409 (already exists) falls
      //    through to an in-place replace; an absent CRD short-circuits to a fail-closed
      //    not-applied result rather than crashing the reconcile.
      await this.customApi.createNamespacedCustomObject({
        group: _ED_GROUP, version: _ED_VERSION, namespace, plural: _ED_DNSENDPOINT_PLURAL, body: manifest,
      });
      return { applied: true };
    }
    catch (err)
    {
      // 2. No external-dns → the DNSEndpoint CRD is not served. Fail closed, never crash.
      if (_IsCrdAbsent(err, _ED_GROUP, _ED_DNSENDPOINT_PLURAL))
      {
        return { applied: false, reason: "external-dns is not installed (dnsendpoints.externaldns.k8s.io CRD is absent); no DNS record was declared." };
      }

      // 3. 409 Conflict → already exists; fetch the live resourceVersion and replace
      //    in-place so a re-apply converges (idempotent).
      if (_IsConflict(err))
      {
        const existing = await this.customApi.getNamespacedCustomObject({ group: _ED_GROUP, version: _ED_VERSION, namespace, plural: _ED_DNSENDPOINT_PLURAL, name });
        const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
        const body = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), resourceVersion } };
        await this.customApi.replaceNamespacedCustomObject({ group: _ED_GROUP, version: _ED_VERSION, namespace, plural: _ED_DNSENDPOINT_PLURAL, name, body });
        return { applied: true };
      }
      throw err;
    }
  }

  /** @inheritdoc */
  public async deleteDnsEndpoint(namespace: string, name: string): Promise<void>
  {
    try
    {
      await this.customApi.deleteNamespacedCustomObject({ group: _ED_GROUP, version: _ED_VERSION, namespace, plural: _ED_DNSENDPOINT_PLURAL, name });
    }
    catch (err)
    {
      // 404 (already gone) and an absent CRD are both no-ops (idempotent teardown).
      if (_IsNotFound(err) || _IsCrdAbsent(err, _ED_GROUP, _ED_DNSENDPOINT_PLURAL))
      {
        return;
      }
      throw err;
    }
  }
}
