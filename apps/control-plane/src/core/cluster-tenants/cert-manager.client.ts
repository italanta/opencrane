import type * as k8s from "@kubernetes/client-node";

/** cert-manager API group/version for the Certificate custom resource. */
const _CM_GROUP = "cert-manager.io";
const _CM_VERSION = "v1";
/** Plural for the namespaced `Certificate` custom resource. */
const _CM_CERTIFICATE_PLURAL = "certificates";

/** The readiness a cert-manager Certificate reports once issuance completes. */
export interface CertificateReadiness
{
  /** Whether the Certificate's `Ready` condition is `True` (issuance complete). */
  ready: boolean;
  /** Whether cert-manager is installed (the Certificate CRD is served). */
  certManagerInstalled: boolean;
  /** Human-readable reason when not ready (condition message, or CRD-absent note). */
  reason?: string;
}

/**
 * Minimal interface over the cert-manager Certificate operations the
 * OrgDomainProvisioner needs. Injected so unit tests can substitute a fake
 * without a live cluster or the CustomObjectsApi.
 */
export interface CertManagerOperations
{
  /**
   * Apply (create-or-replace) a Certificate CR, idempotently. A re-apply carries
   * the live resourceVersion so it never conflicts. Surfaces `certManagerInstalled:
   * false` (fail-closed, never throws) when the Certificate CRD is absent.
   *
   * @param namespace - Namespace the Certificate (and its Secret) live in.
   * @param manifest  - The Certificate manifest to apply.
   */
  applyCertificate(namespace: string, manifest: Record<string, unknown>): Promise<CertificateReadiness>;

  /**
   * Delete the named Certificate if present; absence (404) and a missing CRD are
   * both no-ops (idempotent teardown).
   *
   * @param namespace - Namespace the Certificate lives in.
   * @param name      - Certificate name.
   */
  deleteCertificate(namespace: string, name: string): Promise<void>;
}

/**
 * Production cert-manager client over the Kubernetes custom-objects API. Mirrors
 * the proven create-then-replace-on-409 pattern in
 * `core/platform-dns/apply-dns-config.ts`, and reads the Certificate's `Ready`
 * condition back so the caller can reflect issuance state.
 *
 * Fail-closed: when the dev/target cluster has NO cert-manager (the Certificate
 * CRD is not served), apply does NOT crash — it returns `certManagerInstalled:
 * false` so the provisioner can surface a clear `ready:false` + reason. The
 * resource-authoring path is real (not a no-op stub): the exact manifest that
 * WOULD be applied is built and the API call IS issued; only an absent CRD short-
 * circuits it.
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
      applied = await this.customApi.createNamespacedCustomObject({
        group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_CERTIFICATE_PLURAL, body: manifest,
      });
    }
    catch (err)
    {
      // No cert-manager → the Certificate CRD is not served. Fail closed, never crash.
      if (_IsCrdAbsent(err))
      {
        return { ready: false, certManagerInstalled: false, reason: "cert-manager is not installed (certificates.cert-manager.io CRD is absent); no Certificate was created." };
      }

      // 409 Conflict → already exists; fetch live resourceVersion and replace in-place.
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
      // 404 (already gone) and an absent CRD are both no-ops.
      if (_IsNotFound(err) || _IsCrdAbsent(err))
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

/** Detect a Kubernetes 409 Conflict (already-exists) across client error shapes. */
function _IsConflict(err: unknown): boolean
{
  return _statusOf(err) === 409;
}

/** Detect a Kubernetes 404 Not Found across client error shapes. */
function _IsNotFound(err: unknown): boolean
{
  return _statusOf(err) === 404;
}

/**
 * Detect an absent CRD — the cluster has no cert-manager. The API server answers a
 * request against an unserved group/version with 404 NotFound (and the body kind is
 * `Status` with reason `NotFound`), so a 404 on a CREATE (which can never be an
 * already-gone delete) signals the CRD is not installed.
 */
function _IsCrdAbsent(err: unknown): boolean
{
  if (_statusOf(err) !== 404)
  {
    return false;
  }
  // A create returning 404 means the resource TYPE (CRD) is not served — there is no
  // object to be "not found" on a create otherwise.
  const reason = (err as { body?: { reason?: string }; reason?: string })?.body?.reason
    ?? (err as { reason?: string })?.reason;
  return reason === undefined || reason === "NotFound";
}

/** Extract a Kubernetes API status code from common client error shapes. */
function _statusOf(err: unknown): number | undefined
{
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } };
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode ?? e?.body?.code;
}
