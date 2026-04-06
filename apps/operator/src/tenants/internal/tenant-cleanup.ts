import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { deleteResource } from "../../infra/k8s.js";

/**
 * Handles deletion of tenant-managed Kubernetes resources.
 */
export class TenantCleanup
{
  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Scoped logger for tenant-cleanup messages. */
  private log: Logger;

  /**
   * Create a new TenantCleanup helper.
   */
  constructor(objectApi: k8s.KubernetesObjectApi, log: Logger)
  {
    this.objectApi = objectApi;
    this.log = log.child({ component: "tenant-cleanup" });
  }

  /**
   * Remove tenant child resources except persisted storage and encryption key.
   */
  async cleanupTenant(name: string, namespace: string): Promise<void>
  {
    await deleteResource(this.objectApi, {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: `openclaw-${name}-config`, namespace },
    }, this.log);

    await deleteResource(this.objectApi, {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: `openclaw-${name}`, namespace },
    }, this.log);
  }
}
