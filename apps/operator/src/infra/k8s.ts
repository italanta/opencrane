import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

/**
 * Apply a Kubernetes resource using server-side apply (create or update).
 * Falls back to create if the resource doesn't exist yet.
 * 
 * @param client - Kubernetes object API client used for patch/create operations.
 * @param resource - Kubernetes object to apply.
 * @param log - Logger used for apply/create lifecycle messages.
 */
export async function _K8sApplyResource<T extends k8s.KubernetesObject>(
  client: k8s.KubernetesObjectApi,
  resource: T,
  log: Logger,
): Promise<T>
{
  const name = resource.metadata?.name;
  const kind = resource.kind;

  try {
    const response = await client.patch(resource);
    log.debug({ kind, name }, "resource applied");
    return response as T;
  } catch (err: unknown) {
    const status = _isK8sError(err) ? err.statusCode : undefined;
    if (status === 404) {
      const response = await client.create(resource);
      log.info({ kind, name }, "resource created");
      return response as T;
    }
    throw err;
  }
}

/**
 * Delete a Kubernetes resource, ignoring 404 (already gone).
 * 
 * @param client - Kubernetes object API client used for delete operations.
 * @param resource - Kubernetes object to delete.
 * @param log - Logger used for delete lifecycle messages.
 */
export async function _K8sDeleteResource(
  client: k8s.KubernetesObjectApi,
  resource: k8s.KubernetesObject,
  log: Logger,
): Promise<void>
{
  const name = resource.metadata?.name;
  const kind = resource.kind;

  try {
    await client.delete(resource);
    log.info({ kind, name }, "resource deleted");
  } catch (err: unknown) {
    const status = _isK8sError(err) ? err.statusCode : undefined;
    if (status === 404) {
      log.debug({ kind, name }, "resource already gone");
      return;
    }
    throw err;
  }
}

/**
 * Type guard that checks whether an unknown error value is a Kubernetes
 * API error carrying a numeric statusCode property.
 * 
 * @param err - Unknown error value to validate.
 */
function _isK8sError(err: unknown): err is { statusCode: number }
{
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as Record<string, unknown>).statusCode === "number"
  );
}
