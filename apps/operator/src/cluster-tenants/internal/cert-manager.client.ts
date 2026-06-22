import type * as k8s from "@kubernetes/client-node";

import { _IsConflict, _IsCrdAbsent, _IsNotFound } from "./k8s-api-errors.js";
import type { CertManagerOperations, CertificateReadiness } from "./org-domain-provisioner.types.js";

/** cert-manager API group for the Certificate custom resource. */
const _CM_GROUP = "cert-manager.io";
/** cert-manager API version for the Certificate custom resource. */
const _CM_VERSION = "v1";
/** Plural for the namespaced `Certificate` custom resource. */
const _CM_CERTIFICATE_PLURAL = "certificates";

/**
 * Production cert-manager client over the operator's Kubernetes custom-objects API.
 * Mirrors the proven create-then-replace-on-409 pattern the operator uses for its
 * own child resources, and reads the Certificate's `Ready` condition back so the
 * caller can reflect issuance state.
 *
 * Fail-closed: when the dev/target cluster has NO cert-manager (the Certificate CRD
 * is not served), apply does NOT crash — it returns `certManagerInstalled: false`
 * so the provisioner can surface a clear `ready:false` + reason. The resource-
 * authoring path is real (not a no-op stub): the exact manifest that WOULD be
 * applied is built and the API call IS issued; only an absent CRD short-circuits it.
 */
export class CertManagerClient implements CertManagerOperations
{
  /** Kubernetes custom-objects client (Certificate CRDs). */
  private readonly customApi: k8s.CustomObjectsApi;

  /**
   * @param customApi - Kubernetes custom-objects client.
   */
  public constructor(customApi: k8s.CustomObjectsApi)
  {
    this.customApi = customApi;
  }

  /** @inheritdoc */
  public async applyCertificate(namespace: string, manifest: Record<string, unknown>): Promise<CertificateReadiness>
  {
    const name = ((manifest.metadata as Record<string, unknown>)?.name) as string;

    let applied: unknown;
    try
    {
      // 1. Create first — the common path on a fresh org. A 409 (already exists)
      //    falls through to an in-place replace; an absent CRD short-circuits to
      //    a fail-closed not-installed result rather than crashing the reconcile.
      applied = await this.customApi.createNamespacedCustomObject({
        group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_CERTIFICATE_PLURAL, body: manifest,
      });
    }
    catch (err)
    {
      // 2. No cert-manager → the Certificate CRD is not served. Fail closed, never crash.
      if (_IsCrdAbsent(err, _CM_GROUP, _CM_CERTIFICATE_PLURAL))
      {
        return { ready: false, certManagerInstalled: false, reason: "cert-manager is not installed (certificates.cert-manager.io CRD is absent); no Certificate was created." };
      }

      // 3. 409 Conflict → already exists; fetch live resourceVersion and replace in-place
      //    so a re-apply converges (idempotent) without a content-type patch pitfall.
      if (_IsConflict(err))
      {
        const existing = await this.customApi.getNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_CERTIFICATE_PLURAL, name });
        const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
        const body = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), resourceVersion } };
        applied = await this.customApi.replaceNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_CERTIFICATE_PLURAL, name, body });
        return _readReadiness(applied);
      }
      throw err;
    }

    return _readReadiness(applied);
  }

  /** @inheritdoc */
  public async deleteCertificate(namespace: string, name: string): Promise<void>
  {
    try
    {
      await this.customApi.deleteNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_CERTIFICATE_PLURAL, name });
    }
    catch (err)
    {
      // 404 (already gone) and an absent CRD are both no-ops (idempotent teardown).
      if (_IsNotFound(err) || _IsCrdAbsent(err, _CM_GROUP, _CM_CERTIFICATE_PLURAL))
      {
        return;
      }
      throw err;
    }
  }
}

/**
 * Read the `Ready` condition off a Certificate object. cert-manager stamps
 * `status.conditions[type=Ready].status` once DNS-01 issuance completes; absent or
 * `False` means issuance is still in flight (the gated `ready:false` case).
 *
 * @param obj - The Certificate object returned by the API.
 * @returns The readiness derived from the object's `Ready` condition.
 */
function _readReadiness(obj: unknown): CertificateReadiness
{
  const conditions = (obj as { status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> } })?.status?.conditions ?? [];
  const ready = conditions.find(c => c.type === "Ready");
  if (ready?.status === "True")
  {
    return { ready: true, certManagerInstalled: true };
  }
  return { ready: false, certManagerInstalled: true, reason: ready?.message ?? "Certificate issuance is still in flight (DNS-01 challenge not yet complete)." };
}
