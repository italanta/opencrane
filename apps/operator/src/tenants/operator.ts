import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../config.js";
import { _BuildHostingAdapter, type HostingAdapter } from "../hosting/index.js";

import type { Tenant } from "./models/tenant.interface.js";
import { TenantPolicyResolutionState, TenantStatusPhase } from "./models/tenant-status.interface.js";

import { __K8sApplyResource } from "../infra/k8s.js";
import { _RunWatchLoop, K8sWatchEventType } from "../shared/watch-runner.js";
import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "../shared/crd-constants.js";
import { _BuildClusterTenantLimitRange, _BuildClusterTenantNamespace, _BuildClusterTenantResourceQuota, _BuildConfigMap, _BuildDeployment, _BuildGatewayNetworkPolicy, _BuildService, _BuildServiceAccount, _BuildStatePvc } from "./deploy/index.js";
import { TenantCleanup } from "./destroy/tenant-cleanup.js";

import { TenantEncryptionKeys } from "./internal/tenant-encryption-keys.js";
import { TenantLiteLlmKeys } from "./internal/tenant-litellm-keys.js";
import { _ResolveTenantPolicy } from "./internal/policy-resolution.js";
import { _FetchTenantModels } from "./internal/tenant-models.js";
import { _ResolveClusterTenant } from "./internal/cluster-tenant-resolution.js";
import type { ClusterTenantResource } from "./internal/cluster-tenant-resolution.types.js";
import { _ResolveOrgServingDomain } from "./internal/org-serving-domain.js";
import { TenantStatusWriter } from "./internal/tenant-status-writer.js";

/**
 * Watches Tenant custom resources and reconciles the corresponding
 * Kubernetes workloads.
 *
 * All dependencies are injected via the constructor — use
 * {@link _CreateTenantOperator} to assemble from a raw KubeConfig in
 * production entry-points, and pass mocks directly in tests.
 */
export class TenantOperator
{
  /** Watch client for streaming Tenant CR events. */
  private watch: k8s.Watch;

  /** Client for custom resources (AccessPolicy, status subresource). */
  private customApi: k8s.CustomObjectsApi;

  /** Client for CoreV1 resources (ServiceAccount, Secret, ConfigMap, Service, PVC). */
  private coreApi: k8s.CoreV1Api;

  /** Client for AppsV1 resources (Deployment). */
  private appsApi: k8s.AppsV1Api;

  /** Client for NetworkingV1 resources (Ingress). */
  private networkingApi: k8s.NetworkingV1Api;

  /** Scoped logger for tenant-operator messages. */
  private log: Logger;

  /** Operator runtime configuration loaded from environment. */
  private config: OpenClawTenantOperatorConfig;

  /** Hosting adapter — provides cloud-specific storage, identity, and ingress behaviour. */
  private hosting: HostingAdapter;

  /** Helper for removing tenant-owned resources during delete flows. */
  private cleanup: TenantCleanup;

  /** Helper for patching Tenant status subresource. */
  private statusWriter: TenantStatusWriter;

  /** Helper for per-tenant AES encryption key Secret lifecycle. */
  private encryptionKeys: TenantEncryptionKeys;

  /** Helper for LiteLLM virtual key provisioning and Secret creation. */
  private liteLlmKeys: TenantLiteLlmKeys;

  /**
   * Create a new TenantOperator with pre-wired dependencies.
   * Prefer {@link _CreateTenantOperator} in production entry-points.
   */
  constructor(watch: k8s.Watch,
              customApi: k8s.CustomObjectsApi,
              coreApi: k8s.CoreV1Api,
              appsApi: k8s.AppsV1Api,
              networkingApi: k8s.NetworkingV1Api,
              log: Logger,
              config: OpenClawTenantOperatorConfig,
              hosting: HostingAdapter,
              cleanup: TenantCleanup,
              statusWriter: TenantStatusWriter,
              encryptionKeys: TenantEncryptionKeys,
              liteLlmKeys: TenantLiteLlmKeys)
  {
    this.watch = watch;
    this.customApi = customApi;
    this.coreApi = coreApi;
    this.appsApi = appsApi;
    this.networkingApi = networkingApi;
    this.log = log;
    this.config = config;
    this.hosting = hosting;
    this.cleanup = cleanup;
    this.statusWriter = statusWriter;
    this.encryptionKeys = encryptionKeys;
    this.liteLlmKeys = liteLlmKeys;
  }

  /**
   * Begin watching for Tenant CR events and reconcile on each change.
   * Automatically reconnects on watch errors with a 5-second backoff.
   */
  async start(): Promise<void>
  {
    const ns = this.config.watchNamespace;
    const path = ns
      ? `/apis/${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}/namespaces/${ns}/${TENANT_CRD_PLURAL}`
      : `/apis/${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}/${TENANT_CRD_PLURAL}`;

    await _RunWatchLoop<Tenant>({
      watch: this.watch,
      path,
      log: this.log,
      startMessage: "starting tenant watch",
      reconnectMessage: "watch connection lost, reconnecting...",
      failedMessage: "watch failed, retrying...",
      onEvent: async (type: K8sWatchEventType | string, tenant: Tenant) => {
        await this.handleEvent(type, tenant);
      },
    });
  }

  /**
   * Route a watch event to the appropriate reconciliation handler.
   */
  private async handleEvent(type: K8sWatchEventType | string, tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "tenant event");

    switch (type)
    {
      case K8sWatchEventType.Added:
      case K8sWatchEventType.Modified:
        if (tenant.spec.suspended)
        {
          await this.suspendTenant(tenant);
        }
        else
        {
          await this.reconcileTenant(tenant);
        }
        break;
      case K8sWatchEventType.Deleted:
        await this.cleanupTenant(tenant);
        break;
    }
  }

  /**
   * Reconcile all child resources for a running tenant and update status.
   *
   * Reconciliation is idempotent: it can be called repeatedly on the same
   * Tenant CR and will converge to the desired state without side effects.
   * Each child resource is applied via server-side apply, so existing
   * resources are updated in-place and missing ones are created.
   *
   * The reconcile order matters: later resources depend on earlier ones.
   * ServiceAccount must exist before the Deployment can reference it;
   * the encryption key Secret must exist before the Deployment mounts it;
   * the ConfigMap must exist before the Deployment reads it.
   *
   * On any failure the error is caught, `status.phase` is set to `"Error"`
   * with the error message, and the error is re-thrown so the watch loop
   * logs it and the event is not silently swallowed.
   */
  async reconcileTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;

    // The Tenant CR itself always lives in its own namespace; status patches must
    // target that namespace regardless of where child resources are deployed.
    const crNamespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name, provider: this.hosting.provider }, "reconciling tenant");

    try
    {
      // 0a. Parent ClusterTenant — resolve the deployment target namespace. Ref-less
      //     openclaws stay on the install namespace (byte-for-byte unchanged); a ref'd
      //     openclaw lands in the parent's bound namespace (opt-in multi-tenancy).
      const clusterTenantResolution = await _ResolveClusterTenant(this.customApi, tenant, crNamespace);
      const namespace = clusterTenantResolution.targetNamespace;
      if (clusterTenantResolution.ref && clusterTenantResolution.clusterTenant)
      {
        this.log.info({ name, clusterTenantRef: tenant.spec.clusterTenantRef, namespace }, "openclaw attached to cluster tenant");
        // 0a-i. Native isolation — fence the customer's namespace before any child
        //       resource lands in it. Ref-less openclaws skip this block entirely so
        //       the default (single-install) path stays byte-for-byte unchanged.
        await this.enforceClusterTenantIsolation(clusterTenantResolution.clusterTenant, namespace);
      }
      const compute = clusterTenantResolution.clusterTenant?.spec.compute;
      // Fixed-wildcard topology — derive the UserTenant ingress host from the org's
      // domain under the platform wildcard base (`config.ingressDomain`). An org
      // (ClusterTenant) is served at its DERIVED apex `<org>.<base>`, so its users
      // land at `<user>.<org>.<base>` — handled by `_ResolveOrgServingDomain`, which
      // also lets a customer-vanity domain (CNAMEd onto the apex) override the apex.
      // Ref-less openclaws have no parent org → they stay at the bare
      // `<user>.<base>` per-instance host, so the default path is unchanged.
      const ingressDomain = _ResolveOrgServingDomain(
        clusterTenantResolution.clusterTenant?.metadata?.name,
        clusterTenantResolution.clusterTenant?.spec.vanityDomain,
        this.config.ingressDomain,
      );

      // 0b. Effective policy — resolve policyRef deterministically so runtime behavior
      //    is predictable even when selectors or default policies are configured.
      const policyResolution = await _ResolveTenantPolicy(this.customApi, this.config, tenant, namespace);
      const effectivePolicyRef = policyResolution.effectivePolicy?.metadata?.name;
      if (policyResolution.state === TenantPolicyResolutionState.PolicyNotFound
        || policyResolution.state === TenantPolicyResolutionState.PolicyConflict
        || policyResolution.state === TenantPolicyResolutionState.DefaultPolicyNotFound)
      {
        await this.statusWriter.patchStatus(tenant, crNamespace, {
          phase: TenantStatusPhase.Error,
          message: policyResolution.message,
          effectivePolicyRef,
          policyResolutionSource: policyResolution.source,
          policyResolutionState: policyResolution.state,
          lastReconciled: new Date().toISOString(),
        });
        throw new Error(policyResolution.message);
      }

      const effectiveTenant: Tenant = {
        ...tenant,
        spec: {
          ...tenant.spec,
          policyRef: effectivePolicyRef,
        },
      };

      // 0c. Allowed model set — best-effort fetch of the tenant's registered models
      //     from the control-plane internal API. This is a deliberate, non-fatal
      //     operator → control-plane dependency: a null result (outage, 404, timeout)
      //     falls back to today's unrestricted behaviour and never blocks reconcile.
      const modelSet = await _FetchTenantModels(this.config.controlPlaneInternalUrl, name, this.log);

      // 1. ServiceAccount — identity annotations come from the adapter; empty on-prem,
      //    Workload Identity annotation on GKE, IRSA on EKS, etc.
      await __K8sApplyResource(this.coreApi, _BuildServiceAccount(this.hosting, effectiveTenant, namespace), this.log);

      // 2. External storage — provision per-cloud via the adapter SDK (GCS bucket etc).
      //    No-op on-prem; idempotent so safe to call on every reconcile.
      await this.hosting.provisionTenantStorage({ tenantName: name, namespace });

      // 3. Encryption key Secret — generates a random 32-byte AES key on first reconcile
      //    and stores it as a K8s Secret. Idempotent: existing secrets are not rotated.
      await this.encryptionKeys.ensureEncryptionKeySecret(name, namespace);

      // 4. LiteLLM key Secret — creates a per-tenant virtual key in LiteLLM and stores
      //    it in a tenant Secret mounted through env var. Skipped when LiteLLM is disabled.
      //    Best-effort so transient LiteLLM backend issues do not block tenant startup.
      try
      {
        await this.liteLlmKeys.ensureLiteLlmKeySecret(effectiveTenant, namespace, modelSet);
      }
      catch (err)
      {
        this.log.warn({ err, name }, "litellm key provisioning failed; continuing reconcile");
      }

      // 5. ConfigMap — serialises the base OpenClaw JSON config merged with any
      //    spec.configOverrides the tenant author provided.
      await __K8sApplyResource(this.coreApi, _BuildConfigMap(this.config, effectiveTenant, namespace, policyResolution.effectivePolicy, modelSet), this.log);

      // 6. State volume — adapter decides CSI mount (cloud) vs PVC (on-prem).
      //    Create the PVC only when the adapter requests it (on-prem path).
      const stateVolume = this.hosting.buildStateVolume(name);
      if (stateVolume.requiresPvc)
      {
        await __K8sApplyResource(this.coreApi, _BuildStatePvc(name, namespace), this.log);
      }

      // 7. Deployment — single-replica pod running the tenant's OpenClaw gateway.
      //    Mounts the ConfigMap, encryption key, state volume, and projected identity tokens.
      await __K8sApplyResource(this.appsApi, _BuildDeployment(this.config, stateVolume, effectiveTenant, namespace, compute), this.log);

      // 8. Service — ClusterIP that makes the gateway reachable inside the cluster
      //    on the configured gateway port.
      await __K8sApplyResource(this.coreApi, _BuildService(this.config, effectiveTenant, namespace), this.log);

      // 9. NetworkPolicy — lock the gateway port to the identity-routing proxy (now folded
      //    into the operator) so the trusted-proxy auth (CONN.4) can't be abused by other
      //    in-cluster pods. No per-user Ingress is minted: every user reaches their pod
      //    through the org's single host `<org>.<base>`, reverse-proxied by the operator to
      //    this pod's Service. The org host is served by the platform wildcard Ingress +
      //    cert and gets an explicit external-dns record (see the org-domain provisioner).
      await __K8sApplyResource(this.networkingApi, _BuildGatewayNetworkPolicy(this.config, effectiveTenant, namespace), this.log);

      // 10. Status — write the observed Running state back to the Tenant CR so that
      //    kubectl, the control-plane API, and the UI all see the current phase.
      await this.statusWriter.patchStatus(tenant, crNamespace, {
        phase: TenantStatusPhase.Running,
        podName: `openclaw-${name}`,
        // Served at the ORG host (`<org>.<base>` or vanity) via the proxy — no per-user subdomain.
        ingressHost: ingressDomain,
        effectivePolicyRef,
        policyResolutionSource: policyResolution.source,
        policyResolutionState: policyResolution.state,
        lastReconciled: new Date().toISOString(),
      });
    }
    catch (err)
    {
      this.log.error({ err, name }, "reconcile failed");
      await this.statusWriter.patchStatus(tenant, crNamespace, {
        phase: TenantStatusPhase.Error,
        message: err instanceof Error ? err.message : String(err),
        lastReconciled: new Date().toISOString(),
      });
      throw err;
    }
  }

  /**
   * Provision and fence the per-ClusterTenant namespace for the opt-in
   * multi-tenant path.
   *
   * This is only reached when an openclaw references a ClusterTenant; it
   * ensures the customer's namespace exists with PSA `restricted` enforcement,
   * stamps an aggregate ResourceQuota derived from the customer's quota, and
   * lays down a default LimitRange so quota-constrained pods still schedule.
   * Live PSA/quota enforcement is the cluster seam; here we converge the
   * objects idempotently via server-side create-or-replace.
   *
   * @param clusterTenant - Resolved parent ClusterTenant carrying quota/compute.
   * @param namespace - The customer's bound namespace to fence.
   */
  private async enforceClusterTenantIsolation(clusterTenant: ClusterTenantResource, namespace: string): Promise<void>
  {
    const clusterTenantName = clusterTenant.metadata?.name ?? namespace;

    // 1. Namespace — ensure the fenced namespace exists and carries the PSA
    //    restricted enforce/warn/audit labels before any workload lands in it.
    await __K8sApplyResource(this.coreApi, _BuildClusterTenantNamespace(namespace, clusterTenantName), this.log);

    // 2. ResourceQuota — cap the customer's aggregate CPU/memory/pods/storage/GPU
    //    so a single customer cannot starve the cluster. Only stamped when the
    //    ClusterTenant actually declared a quota block.
    const quota = clusterTenant.spec.resources?.quota;
    if (quota)
    {
      await __K8sApplyResource(this.coreApi, _BuildClusterTenantResourceQuota(namespace, clusterTenantName, quota), this.log);

      // 3. LimitRange — a quota over requests.* rejects pods that omit requests;
      //    supply per-container defaults so unannotated workloads still schedule.
      await __K8sApplyResource(this.coreApi, _BuildClusterTenantLimitRange(namespace, clusterTenantName), this.log);
    }
  }

  /**
   * Suspend a tenant by scaling the deployment to zero replicas.
   */
  private async suspendTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;

    // The Tenant CR lives in its own namespace; status patches target it
    // regardless of where the (suspended) Deployment is rebuilt.
    const crNamespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "suspending tenant");

    // 1. Resolve the parent ClusterTenant so the suspended Deployment is rebuilt in
    //    the same namespace and with the same compute placement as the live one;
    //    ref-less openclaws resolve to the install namespace + no compute, so the
    //    default (single-install) path stays byte-for-byte unchanged.
    const clusterTenantResolution = await _ResolveClusterTenant(this.customApi, tenant, crNamespace);
    const namespace = clusterTenantResolution.targetNamespace;
    const compute = clusterTenantResolution.clusterTenant?.spec.compute;

    // 2. Rebuild the Deployment identically but scaled to zero so the pod stops
    //    without losing its namespace or scheduling identity.
    const stateVolume = this.hosting.buildStateVolume(name);
    const deployment = _BuildDeployment(this.config, stateVolume, tenant, namespace, compute);
    deployment.spec!.replicas = 0;
    await __K8sApplyResource(this.appsApi, deployment, this.log);

    // 3. Record the suspended phase against the CR namespace.
    await this.statusWriter.patchStatus(tenant, crNamespace, {
      phase: TenantStatusPhase.Suspended,
      lastReconciled: new Date().toISOString(),
    });
  }

  /**
   * Remove child resources for a deleted tenant.
   * Retains: external storage bucket and encryption key Secret.
   */
  private async cleanupTenant(tenant: Tenant): Promise<void>
  {
    const name = tenant.metadata!.name!;
    const namespace = tenant.metadata!.namespace ?? "default";

    this.log.info({ name }, "cleaning up tenant resources");

    await this.cleanup.cleanupTenant(name, namespace);

    this.log.info({ name }, "tenant cleanup complete (storage + encryption key retained)");
  }

}

/**
 * Wire all dependencies from a KubeConfig and return a ready-to-start TenantOperator.
 *
 * This factory owns all K8s client construction so that `TenantOperator` itself
 * only depends on the abstractions it actually needs. Use this from application
 * entry-points; inject helpers directly in tests.
 *
 * @param kc - Resolved KubeConfig (cluster or in-cluster credentials).
 * @param config - Operator runtime configuration from environment variables.
 * @param baseLog - Root pino logger; scoped to `tenant-operator` component inside.
 */
export function _CreateTenantOperator(kc: k8s.KubeConfig, config: OpenClawTenantOperatorConfig, baseLog: Logger): TenantOperator
{
  // 1. K8s API clients — each scoped to one API group; none leak into TenantOperator directly.
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  const watch = new k8s.Watch(kc);

  // 2. Scoped logger — child-scoped here so all tenant-operator log lines share the label.
  const log = baseLog.child({ component: "tenant-operator" });

  // 3. Hosting adapter — selected once at startup; defaults to on-prem with no cloud config.
  const hosting = _BuildHostingAdapter(config);
  log.info({ provider: hosting.provider }, "hosting adapter initialised");

  // 4. K8s helpers — each receives only the API clients it actually calls.
  const cleanup = new TenantCleanup(objectApi, log);
  const statusWriter = new TenantStatusWriter(customApi, log);
  const encryptionKeys = new TenantEncryptionKeys(coreApi, objectApi, log);
  const liteLlmKeys = new TenantLiteLlmKeys(config, coreApi, objectApi, log);

  return new TenantOperator(watch, customApi, coreApi, appsApi, networkingApi, log, config, hosting, cleanup, statusWriter, encryptionKeys, liteLlmKeys);
}
