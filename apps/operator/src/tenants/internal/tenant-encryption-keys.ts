import { randomBytes } from "node:crypto";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { applyResource } from "../../infra/k8s.js";
import { TenantResourceBuilder } from "./tenant-resource-builder.js";

/**
 * Manages the per-tenant AES encryption key Secret lifecycle.
 *
 * Each tenant gets a unique 256-bit (32-byte) encryption key stored as a
 * Kubernetes Secret. The key is used by the OpenClaw gateway process to
 * encrypt tenant-specific secrets stored in the GCS-backed state directory.
 *
 * Design decisions:
 * - Keys are generated once on first reconcile and never rotated automatically.
 *   Automatic rotation would require re-encrypting all tenant secrets, which
 *   needs a coordinated migration, not just a Secret update.
 * - Keys are stored in a dedicated named Secret (`openclaw-<name>-encryption-key`)
 *   rather than bundled into a shared Secret. This enables per-tenant RBAC
 *   so the operator can grant each pod access only to its own key Secret.
 * - The key is mounted as a file (`/etc/openclaw/encryption-key/key`) rather
 *   than env var to avoid exposure in `ps aux` or crash reports.
 */
export class TenantEncryptionKeys
{
  /** Client for core Kubernetes API operations (Secrets). */
  private coreApi: k8s.CoreV1Api;

  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Builder used to produce consistent tenant resource labels. */
  private resourceBuilder: TenantResourceBuilder;

  /** Scoped logger for encryption key lifecycle events. */
  private log: Logger;

  /**
   * Create a new TenantEncryptionKeys helper bound to the operator dependencies.
   */
  constructor(
    coreApi: k8s.CoreV1Api,
    objectApi: k8s.KubernetesObjectApi,
    resourceBuilder: TenantResourceBuilder,
    log: Logger,
  )
  {
    this.coreApi = coreApi;
    this.objectApi = objectApi;
    this.resourceBuilder = resourceBuilder;
    this.log = log;
  }

  /**
   * Ensure a per-tenant encryption key Secret exists in the given namespace.
   *
   * This method is idempotent. If the Secret already exists the call returns
   * immediately without modifying the existing key. That guarantees that pod
   * restarts, watch reconnects, and repeated reconcile calls do not silently
   * rotate a key and invalidate the tenant's encrypted state.
   *
   * @param tenantName - The tenant CR name, used to derive the Secret name.
   * @param namespace  - Namespace where the Secret is created.
   */
  async ensureEncryptionKeySecret(tenantName: string, namespace: string): Promise<void>
  {
    const secretName = `openclaw-${tenantName}-encryption-key`;

    // 1. Idempotency check — read the existing Secret; if present, nothing to do.
    try
    {
      await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
      this.log.debug({ name: tenantName, secretName }, "encryption key secret already exists");
      return;
    }
    catch
    {
      // Secret does not exist — continue to creation.
    }

    // 2. Key generation — produce a cryptographically random 32-byte AES-256 key.
    //    Buffer.from(...).toString("base64") is used so the Secret data field
    //    holds a single base64-encoded value that the Kubelet mounts as a file.
    const key = randomBytes(32).toString("base64");

    // 3. Secret creation — write the key to a dedicated labeled Secret so the
    //    Deployment can project it as a read-only file mount at the known path.
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace,
        labels: this.resourceBuilder.buildTenantLabels(tenantName),
      },
      type: "Opaque",
      data: { key },
    };

    await applyResource(this.objectApi, secret, this.log);
    this.log.info({ name: tenantName, secretName }, "created encryption key secret");
  }
}
