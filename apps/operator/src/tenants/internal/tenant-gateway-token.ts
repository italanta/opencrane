import { randomBytes } from "node:crypto";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import { __K8sApplyResource } from "../../infra/k8s.js";
import { _BuildTenantLabels } from "../deploy/tenant-labels.js";

/**
 * Manages the per-tenant OpenClaw gateway auth token Secret lifecycle (OC-2 / B2).
 *
 * The OpenClaw gateway refuses to bind to the LAN without an auth credential
 * (`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN`), so every tenant pod needs a
 * token provisioned before its gateway can start. Each tenant gets a unique
 * random token stored as a Kubernetes Secret and projected into the pod via
 * `secretKeyRef` — never written into the Tenant CRD/spec (a queryable, plaintext
 * surface) and never passed as a literal.
 *
 * This token is the control-plane↔gateway trust anchor: the operator gives it to
 * the pod, and the control-plane reads the same Secret to broker scoped,
 * short-lived connection credentials to browsers (see the `/auth/pod-token`
 * broker). It is the server-side admin credential and is NOT handed to clients.
 *
 * Design decisions (mirroring {@link TenantEncryptionKeys}):
 * - Generated once on first reconcile and never rotated automatically — rotation
 *   would require a coordinated restart of the pod and re-broker of live clients.
 * - Stored in a dedicated named Secret (`openclaw-<name>-gateway-token`) so the
 *   operator can grant each pod (and the control-plane) least-privilege access.
 * - Surfaced as an env var via `secretKeyRef` because the gateway reads
 *   `OPENCLAW_GATEWAY_TOKEN` from the environment at startup.
 */
export class TenantGatewayTokens
{
  /** Client for core Kubernetes API operations (Secrets). */
  private coreApi: k8s.CoreV1Api;

  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Scoped logger for gateway token lifecycle events. */
  private log: Logger;

  /**
   * Create a new TenantGatewayTokens helper bound to the operator dependencies.
   */
  constructor(
    coreApi: k8s.CoreV1Api,
    objectApi: k8s.KubernetesObjectApi,
    log: Logger,
  )
  {
    this.coreApi = coreApi;
    this.objectApi = objectApi;
    this.log = log;
  }

  /**
   * Ensure a per-tenant gateway token Secret exists in the given namespace.
   *
   * Idempotent: if the Secret already exists the call returns immediately without
   * rotating the token, so pod restarts, watch reconnects, and repeated reconciles
   * do not invalidate live broker credentials or force a gateway re-bind.
   *
   * @param tenantName - The tenant CR name, used to derive the Secret name.
   * @param namespace  - Namespace where the Secret is created.
   */
  async ensureGatewayTokenSecret(tenantName: string, namespace: string): Promise<void>
  {
    const secretName = `openclaw-${tenantName}-gateway-token`;

    // 1. Idempotency check — read the existing Secret; if present, nothing to do.
    try
    {
      await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
      this.log.debug({ name: tenantName, secretName }, "gateway token secret already exists");
      return;
    }
    catch
    {
      // Secret does not exist — continue to creation.
    }

    // 2. Token generation — 256 bits of randomness as a hex string, used verbatim
    //    as the gateway auth token the pod and control-plane share.
    const token = randomBytes(32).toString("hex");

    // 3. Secret creation — `stringData` lets the API server base64-encode the raw
    //    token for us, so the projected `OPENCLAW_GATEWAY_TOKEN` env is the token
    //    string exactly.
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace,
        labels: _BuildTenantLabels(tenantName),
      },
      type: "Opaque",
      stringData: { token },
    };

    await __K8sApplyResource(this.objectApi, secret, this.log);
    this.log.info({ name: tenantName, secretName }, "created gateway token secret");
  }
}
