/**
 * Shared classification of Kubernetes API errors across the client error shapes the
 * `@kubernetes/client-node` library throws. Used by the custom-resource clients
 * (`CertManagerClient`, `DnsEndpointClient`) so the create-or-replace / fail-closed-on-
 * absent-CRD logic lives in exactly one place.
 */

/**
 * Extract a Kubernetes API status code from common client error shapes.
 *
 * @param err - The thrown error to inspect.
 * @returns The numeric status code, or undefined when none is present.
 */
export function _StatusOf(err: unknown): number | undefined
{
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } };
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode ?? e?.body?.code;
}

/**
 * Detect a Kubernetes 409 Conflict (already-exists) across client error shapes.
 *
 * @param err - The thrown error to classify.
 * @returns True when the error carries a 409 status.
 */
export function _IsConflict(err: unknown): boolean
{
  return _StatusOf(err) === 409;
}

/**
 * Detect a Kubernetes 404 Not Found across client error shapes.
 *
 * @param err - The thrown error to classify.
 * @returns True when the error carries a 404 status.
 */
export function _IsNotFound(err: unknown): boolean
{
  return _StatusOf(err) === 404;
}

/**
 * Detect an absent CRD — the cluster does not serve the given custom resource — and
 * ONLY that.
 *
 * A 404 on a CREATE is ambiguous: it can mean either (a) the resource TYPE is not served
 * (the CRD is not installed) OR (b) the target NAMESPACE does not exist. We must not
 * conflate the two — reporting "the controller is not installed" when the real fault is a
 * missing namespace would mislead operators.
 *
 * The API server discriminates them in the Status body: an unserved type returns the
 * discovery-style message "the server could not find the requested resource" with no
 * resource-specific `details.name`; a missing namespace returns reason `NotFound` with
 * `details.kind == "namespaces"` (and a namespace name). So we treat a 404 as CRD-absent
 * ONLY when it carries the unserved-type signature (the resource's own API group, or the
 * discovery message, or no `details.kind`/`details.name` pinning it to another object).
 * Any other 404 returns false here and is re-thrown by the caller (fail-loud).
 *
 * @param err     - The thrown error to classify.
 * @param apiGroup - The custom resource's API group (e.g. `cert-manager.io`).
 * @param plural   - The custom resource's plural (e.g. `certificates`); a 404 pinned to a
 *                   DIFFERENT kind is treated as NOT a CRD absence.
 * @returns True only when the 404 unambiguously means the resource's CRD is absent.
 */
export function _IsCrdAbsent(err: unknown, apiGroup: string, plural: string): boolean
{
  if (_StatusOf(err) !== 404)
  {
    return false;
  }

  const body = (err as { body?: { message?: string; details?: { group?: string; kind?: string; name?: string } }; message?: string }).body
    ?? (err as { message?: string; details?: { group?: string; kind?: string; name?: string } });
  const message = (body as { message?: string })?.message ?? (err as { message?: string })?.message ?? "";
  const details = (body as { details?: { group?: string; kind?: string; name?: string } })?.details;

  // (a) The Status names the resource's group as the subject of the 404. The API server
  //     populates `details.group` only when the missing thing is the TYPE itself (an
  //     unserved CRD); a missing namespace carries `details.kind` = "namespaces" with NO
  //     group. So a matching group here is unambiguously a CRD-absent signal regardless
  //     of any `details.name`.
  if (details?.group === apiGroup)
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
  if (details?.kind && details.kind !== plural)
  {
    return false;
  }
  // (d) No details at all and no discovery message → too ambiguous to claim CRD-absent.
  return false;
}
