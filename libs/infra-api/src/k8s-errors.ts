/**
 * Whether a Kubernetes API error carries a given numeric status code.
 *
 * The @kubernetes/client-node library surfaces HTTP failures in at least three
 * shapes (`statusCode`, `code`, `body.code`); this helper normalises them.
 */
export function _IsK8sStatus(err: unknown, code: number): boolean
{
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; code?: unknown; body?: { code?: unknown }; response?: { statusCode?: unknown } };
  if (e.statusCode === code || e.code === code) return true;
  if (e.response && (e.response as { statusCode?: unknown }).statusCode === code) return true;
  return typeof e.body === "object" && e.body !== null && (e.body as { code?: unknown }).code === code;
}

/** Whether the error is a Kubernetes 404 NotFound. */
export function _IsK8sNotFound(err: unknown): boolean
{
  return _IsK8sStatus(err, 404);
}

/** Whether the error is a Kubernetes 409 AlreadyExists / Conflict. */
export function _IsK8sConflict(err: unknown): boolean
{
  return _IsK8sStatus(err, 409);
}
