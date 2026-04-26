import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

/**
 * Apply a Kubernetes resource with create-or-replace semantics.
 *
 * For typed clients this avoids patch content-type pitfalls by creating first
 * and, on conflict, replacing with the latest resourceVersion.
 *
 * @param client - Kubernetes API client used for create/replace operations.
 * @param resource - Kubernetes object to apply.
 * @param log - Logger used for apply/create lifecycle messages.
 */
export async function _K8sApplyResource<T extends k8s.KubernetesObject>(
  client: any,
  resource: T,
  log: Logger,
): Promise<T>
{
  const name = resource.metadata?.name;
  const kind = resource.kind;
  const namespace = resource.metadata?.namespace;

  if (!name || !namespace)
  {
    throw new Error(`resource metadata.name and metadata.namespace are required for apply (${kind ?? "unknown"})`);
  }

  try
  {
    const response = await _createResource(client, resource, namespace);
    log.info({ kind, name }, "resource created");
    return _extractBody<T>(response, resource);
  }
  catch (err: unknown)
  {
    const status = _getK8sErrorStatus(err);
    if (status === 409)
    {
      // PersistentVolumeClaims have an immutable spec once bound — treat
      // AlreadyExists as a no-op rather than attempting a replace that will
      // always fail with 422.
      if (kind === "PersistentVolumeClaim")
      {
        log.debug({ kind, name }, "resource already exists, skipping update (immutable spec)");
        return resource;
      }

      const current = await _readResource(client, resource, namespace, name);
      const withResourceVersion = _withResourceVersion(resource, _extractResourceVersion(current));
      const response = await _replaceResource(client, withResourceVersion, namespace, name);
      log.debug({ kind, name }, "resource updated");
      return _extractBody<T>(response, resource);
    }

    throw err;
  }
}

/**
 * Create the target resource using either KubernetesObjectApi
 * (generic create) or a typed API client create method.
 */
async function _createResource(client: any, resource: k8s.KubernetesObject, namespace: string): Promise<unknown>
{
  if (typeof client.create === "function")
  {
    return client.create(resource);
  }

  switch (resource.kind)
  {
    case "ServiceAccount":
      return client.createNamespacedServiceAccount({ namespace, body: resource });
    case "ConfigMap":
      return client.createNamespacedConfigMap({ namespace, body: resource });
    case "PersistentVolumeClaim":
      return client.createNamespacedPersistentVolumeClaim({ namespace, body: resource });
    case "Service":
      return client.createNamespacedService({ namespace, body: resource });
    case "Deployment":
      return client.createNamespacedDeployment({ namespace, body: resource });
    case "Ingress":
      return client.createNamespacedIngress({ namespace, body: resource });
    case "BucketClaim":
    {
      const { group, version } = _splitApiVersion(resource.apiVersion);
      return client.createNamespacedCustomObject({ group, version, namespace, plural: _toPlural(resource.kind), body: resource });
    }
    default:
      throw new Error(`unsupported resource kind for typed create client: ${resource.kind ?? "unknown"}`);
  }
}

/**
 * Read the existing target resource so a replace can carry resourceVersion.
 */
async function _readResource(client: any, resource: k8s.KubernetesObject, namespace: string, name: string): Promise<unknown>
{
  if (typeof client.read === "function")
  {
    return client.read({ ...resource, metadata: { ...(resource.metadata ?? {}), name, namespace } });
  }

  switch (resource.kind)
  {
    case "ServiceAccount":
      return client.readNamespacedServiceAccount({ name, namespace });
    case "ConfigMap":
      return client.readNamespacedConfigMap({ name, namespace });
    case "PersistentVolumeClaim":
      return client.readNamespacedPersistentVolumeClaim({ name, namespace });
    case "Service":
      return client.readNamespacedService({ name, namespace });
    case "Deployment":
      return client.readNamespacedDeployment({ name, namespace });
    case "Ingress":
      return client.readNamespacedIngress({ name, namespace });
    case "BucketClaim":
    {
      const { group, version } = _splitApiVersion(resource.apiVersion);
      return client.getNamespacedCustomObject({ group, version, namespace, plural: _toPlural(resource.kind), name });
    }
    default:
      throw new Error(`unsupported resource kind for typed read client: ${resource.kind ?? "unknown"}`);
  }
}

/**
 * Replace the target resource after loading current resourceVersion.
 */
async function _replaceResource(client: any, resource: k8s.KubernetesObject, namespace: string, name: string): Promise<unknown>
{
  if (typeof client.replace === "function")
  {
    return client.replace(resource);
  }

  switch (resource.kind)
  {
    case "ServiceAccount":
      return client.replaceNamespacedServiceAccount({ name, namespace, body: resource });
    case "ConfigMap":
      return client.replaceNamespacedConfigMap({ name, namespace, body: resource });
    case "PersistentVolumeClaim":
      return client.replaceNamespacedPersistentVolumeClaim({ name, namespace, body: resource });
    case "Service":
      return client.replaceNamespacedService({ name, namespace, body: resource });
    case "Deployment":
      return client.replaceNamespacedDeployment({ name, namespace, body: resource });
    case "Ingress":
      return client.replaceNamespacedIngress({ name, namespace, body: resource });
    case "BucketClaim":
    {
      const { group, version } = _splitApiVersion(resource.apiVersion);
      return client.replaceNamespacedCustomObject({ group, version, namespace, plural: _toPlural(resource.kind), name, body: resource });
    }
    default:
      throw new Error(`unsupported resource kind for typed replace client: ${resource.kind ?? "unknown"}`);
  }
}

/**
 * Split a Kubernetes apiVersion string into group/version parts.
 */
function _splitApiVersion(apiVersion?: string): { group: string; version: string }
{
  if (!apiVersion)
  {
    throw new Error("resource apiVersion is required for custom resource apply");
  }

  const parts = apiVersion.split("/");
  if (parts.length !== 2)
  {
    throw new Error(`invalid custom resource apiVersion: ${apiVersion}`);
  }

  return { group: parts[0], version: parts[1] };
}

/**
 * Convert Kind to a simple plural resource name (e.g., BucketClaim -> bucketclaims).
 */
function _toPlural(kind?: string): string
{
  if (!kind)
  {
    throw new Error("resource kind is required for custom resource apply");
  }

  return `${kind.toLowerCase()}s`;
}

/**
 * Extract response body returned by typed API calls; fallback to original
 * resource for generic object API return shapes.
 */
function _extractBody<T extends k8s.KubernetesObject>(response: unknown, fallback: T): T
{
  if (typeof response === "object" && response !== null && "body" in response)
  {
    return (response as { body: T }).body;
  }

  return (response as T) ?? fallback;
}

/**
 * Pull metadata.resourceVersion from API responses that may be wrapped
 * ({ body }) or returned as raw Kubernetes objects.
 */
function _extractResourceVersion(response: unknown): string
{
  if (typeof response !== "object" || response === null)
  {
    throw new Error("unable to read current resource version from API response");
  }

  const candidate = ("body" in response)
    ? (response as { body?: unknown }).body
    : response;

  if (typeof candidate !== "object" || candidate === null)
  {
    throw new Error("unable to read current resource version from API response body");
  }

  const metadata = (candidate as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null)
  {
    throw new Error("resource metadata missing in current API object");
  }

  const resourceVersion = (metadata as { resourceVersion?: unknown }).resourceVersion;
  if (typeof resourceVersion !== "string" || resourceVersion.length === 0)
  {
    throw new Error("resourceVersion missing in current API object");
  }

  return resourceVersion;
}

/**
 * Clone a Kubernetes object and set metadata.resourceVersion for replace calls.
 */
function _withResourceVersion<T extends k8s.KubernetesObject>(resource: T, resourceVersion: string): T
{
  return {
    ...resource,
    metadata: {
      ...(resource.metadata ?? {}),
      resourceVersion,
    },
  };
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

/**
 * Extract a Kubernetes API status code from common error shapes.
 */
function _getK8sErrorStatus(err: unknown): number | undefined
{
  if (_isK8sError(err))
  {
    return err.statusCode;
  }

  if (typeof err === "object" && err !== null)
  {
    if ("code" in err && typeof (err as { code?: unknown }).code === "number")
    {
      return (err as { code: number }).code;
    }

    if ("body" in err && typeof (err as { body?: unknown }).body === "object" && (err as { body?: unknown }).body !== null)
    {
      const body = (err as { body: Record<string, unknown> }).body;
      if (typeof body.code === "number")
      {
        return body.code;
      }
    }
  }

  return undefined;
}
