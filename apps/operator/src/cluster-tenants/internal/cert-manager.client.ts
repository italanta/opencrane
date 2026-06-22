import type * as k8s from "@kubernetes/client-node";

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
      if (_isCrdAbsent(err))
      {
        return { ready: false, certManagerInstalled: false, reason: "cert-manager is not installed (certificates.cert-manager.io CRD is absent); no Certificate was created." };
      }

      // 3. 409 Conflict → already exists; fetch live resourceVersion and replace in-place
      //    so a re-apply converges (idempotent) without a content-type patch pitfall.
      if (_isConflict(err))
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
      if (_isNotFound(err) || _isCrdAbsent(err))
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

/**
 * Detect a Kubernetes 409 Conflict (already-exists) across client error shapes.
 *
 * @param err - The thrown error to classify.
 * @returns True when the error carries a 409 status.
 */
function _isConflict(err: unknown): boolean
{
  return _statusOf(err) === 409;
}

/**
 * Detect a Kubernetes 404 Not Found across client error shapes.
 *
 * @param err - The thrown error to classify.
 * @returns True when the error carries a 404 status.
 */
function _isNotFound(err: unknown): boolean
{
  return _statusOf(err) === 404;
}

/**
 * Detect an absent CRD — the cluster has no cert-manager — and ONLY that.
 *
 * A 404 on a CREATE is ambiguous: it can mean either (a) the resource TYPE is not
 * served (the `certificates.cert-manager.io` CRD is not installed) OR (b) the target
 * NAMESPACE does not exist. We must not conflate the two — reporting "cert-manager is
 * not installed" when the real fault is a missing namespace would mislead operators.
 *
 * The API server discriminates them in the Status body: an unserved type returns the
 * discovery-style message "the server could not find the requested resource" with no
 * resource-specific `details.name`; a missing namespace returns reason `NotFound` with
 * `details.kind == "namespaces"` (and a namespace name). So we treat a 404 as CRD-absent
 * ONLY when it carries the unserved-type signature (group cert-manager.io, or the
 * discovery message, or no `details.kind`/`details.name` pinning it to another object).
 * Any other 404 returns false here and is re-thrown by the caller (fail-loud).
 *
 * @param err - The thrown error to classify.
 * @returns True only when the 404 unambiguously means the Certificate CRD is absent.
 */
function _isCrdAbsent(err: unknown): boolean
{
  if (_statusOf(err) !== 404)
  {
    return false;
  }

  const body = (err as { body?: { message?: string; details?: { group?: string; kind?: string; name?: string } }; message?: string }).body
    ?? (err as { message?: string; details?: { group?: string; kind?: string; name?: string } });
  const message = (body as { message?: string })?.message ?? (err as { message?: string })?.message ?? "";
  const details = (body as { details?: { group?: string; kind?: string; name?: string } })?.details;

  // (a) The Status names the cert-manager group as the subject of the 404. The API
  //     server populates `details.group` only when the missing thing is the cert-manager
  //     TYPE itself (an unserved CRD); a missing namespace carries `details.kind` =
  //     "namespaces" with NO group. So a cert-manager group here is unambiguously a
  //     CRD-absent signal regardless of any `details.name`.
  if (details?.group === _CM_GROUP)
  {
    return true;
  }
  // (b) The discovery-layer message for an unserved group/version/kind.
  if (/could not find the requested resource/i.test(message))
  {
    return true;
  }
  // (c) The 404 is pinned to a DIFFERENT object (e.g. a missing namespace) — NOT a CRD
  //     absence. Return false so the caller re-throws rather than misattributing it.
  if (details?.kind && details.kind !== _CM_CERTIFICATE_PLURAL && details.kind !== "certificates")
  {
    return false;
  }
  // (d) No details at all and no discovery message → too ambiguous to claim CRD-absent.
  return false;
}

/**
 * Extract a Kubernetes API status code from common client error shapes.
 *
 * @param err - The thrown error to inspect.
 * @returns The numeric status code, or undefined when none is present.
 */
function _statusOf(err: unknown): number | undefined
{
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } };
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode ?? e?.body?.code;
}
