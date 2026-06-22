import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../config.js";
import { __K8sApplyResource } from "../infra/k8s.js";
import { _RunWatchLoop, K8sWatchEventType } from "../shared/watch-runner.js";
import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "../shared/crd-constants.js";
import { _BuildClusterTenantNamespace } from "../tenants/deploy/index.js";
import type { ClusterTenantResource } from "../tenants/internal/cluster-tenant-resolution.types.js";

import { ClusterTenantStatusWriter } from "./internal/cluster-tenant-status-writer.js";
import { _NamespaceForOrg, _ProvisionBoundary } from "./internal/shared-cluster.provisioner.js";
import { ClusterTenantReconcilePhase } from "./internal/shared-cluster.provisioner.types.js";
import type { OrgDomainProvisioner } from "./internal/org-domain-provisioner.types.js";
import { _BuildOrgDomainProvisioner } from "./internal/org-domain.provisioner.factory.js";

/**
 * Watches the cluster-scoped ClusterTenant custom resource and drives each org
 * from `pending` to `ready` (or `failed`).
 *
 * This closes the "hollow CRUD shell" gap: the control plane dual-writes a
 * `clustertenants` CR on org create (see the DB→K8s bridge), and THIS reconciler
 * is what actually acts on it. It mirrors `TenantOperator.reconcileTenant`:
 * idempotent, server-side apply for child resources, status patched back via the
 * status subresource.
 *
 * Reconcile state machine (per CR event):
 *   1. `provisioning` — stamp the transitional phase.
 *   2. Resolve the isolation boundary via the shared provisioner (binds the
 *      `opencrane-<name>` namespace for in-cluster tiers; `failed` for an
 *      unsupported tier).
 *   3. Fence the bound namespace (PSA `restricted`) idempotently.
 *   4. Invoke the real `OrgDomainProvisioner.provisionOrgDomain(...)` — it applies the
 *      per-org wildcard Certificate and declares the A records as an external-dns
 *      `DNSEndpoint`, runtime-gating to a recorded skip condition when cert-manager or the
 *      DNSEndpoint CRD is genuinely absent; it never throws, so a missing backend cannot fail reconcile.
 *   5. `ready` — stamp `boundNamespace` + provisioner + domain status so
 *      `_ResolveClusterTenant` stops hard-failing and openclaws can attach.
 *
 * Re-running on an already-`ready` org converges to the same state (idempotent).
 */
export class ClusterTenantOperator
{
  /** Watch client for streaming ClusterTenant CR events. */
  private watch: k8s.Watch;

  /** Client for custom resources (status subresource patch). */
  private customApi: k8s.CustomObjectsApi;

  /** Client for CoreV1 resources (the fenced namespace). */
  private coreApi: k8s.CoreV1Api;

  /** Helper for patching ClusterTenant status. */
  private statusWriter: ClusterTenantStatusWriter;

  /** Per-org domain (DNS + wildcard TLS) provisioner; runtime-gated, never throws. */
  private domainProvisioner: OrgDomainProvisioner;

  /** Operator runtime configuration loaded from environment. */
  private config: OpenClawTenantOperatorConfig;

  /** Scoped logger. */
  private log: Logger;

  /**
   * Create a ClusterTenantOperator with pre-wired dependencies.
   * Prefer {@link _CreateClusterTenantOperator} in production entry-points; pass
   * mocks directly in tests.
   */
  constructor(watch: k8s.Watch,
              customApi: k8s.CustomObjectsApi,
              coreApi: k8s.CoreV1Api,
              statusWriter: ClusterTenantStatusWriter,
              domainProvisioner: OrgDomainProvisioner,
              config: OpenClawTenantOperatorConfig,
              log: Logger)
  {
    this.watch = watch;
    this.customApi = customApi;
    this.coreApi = coreApi;
    this.statusWriter = statusWriter;
    this.domainProvisioner = domainProvisioner;
    this.config = config;
    this.log = log;
  }

  /**
   * Begin watching ClusterTenant CR events and reconcile on each change.
   * Reconnects on watch errors with the shared backoff. The CRD is cluster-scoped,
   * so the watch path carries no namespace.
   */
  async start(): Promise<void>
  {
    const path = `/apis/${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}/${CLUSTER_TENANT_CRD_PLURAL}`;

    await _RunWatchLoop<ClusterTenantResource>({
      watch: this.watch,
      path,
      log: this.log,
      startMessage: "starting cluster tenant watch",
      reconnectMessage: "cluster tenant watch connection lost, reconnecting...",
      failedMessage: "cluster tenant watch failed, retrying...",
      onEvent: async (type: K8sWatchEventType | string, clusterTenant: ClusterTenantResource) => {
        await this.handleEvent(type, clusterTenant);
      },
    });
  }

  /** Route a watch event to the reconcile handler (delete is a no-op here). */
  private async handleEvent(type: K8sWatchEventType | string, clusterTenant: ClusterTenantResource): Promise<void>
  {
    const name = clusterTenant.metadata?.name;
    if (!name) return;

    this.log.info({ type, name }, "cluster tenant event");

    switch (type)
    {
      case K8sWatchEventType.Added:
      case K8sWatchEventType.Modified:
        await this.reconcile(clusterTenant);
        break;
      // Delete: namespace GC reclaims the namespaced Certificate/DNSEndpoint CRs, but
      // external-dns only reaps the records it owns once the DNSEndpoint is actually
      // gone — so we explicitly deprovision the per-org domain rather than relying on
      // GC ordering. The bound namespace and attached openclaws are torn down by their
      // own lifecycles.
      case K8sWatchEventType.Deleted:
        await this.deprovision(clusterTenant);
        break;
    }
  }

  /**
   * Reconcile an org from its current phase to `ready` (or `failed`).
   *
   * Idempotent: safe to call repeatedly. On any unexpected error the org is marked
   * `failed` with the message and the error is re-thrown so the watch loop logs it.
   *
   * @param clusterTenant - The ClusterTenant CR being reconciled.
   */
  async reconcile(clusterTenant: ClusterTenantResource): Promise<void>
  {
    const name = clusterTenant.metadata!.name!;
    this.log.info({ name }, "reconciling cluster tenant");

    try
    {
      // 1. Mark provisioning unless already ready — re-running a ready org skips the
      //    transitional write so a converged org produces no status churn.
      if (clusterTenant.status?.phase !== ClusterTenantReconcilePhase.Ready)
      {
        await this.statusWriter.patchStatus(clusterTenant, { phase: ClusterTenantReconcilePhase.Provisioning });
      }

      // 2. Resolve the isolation boundary (binds opencrane-<name> for in-cluster
      //    tiers; reports failed for an unsupported tier).
      const boundary = _ProvisionBoundary(name, clusterTenant.spec.isolationTier);
      if (boundary.phase === ClusterTenantReconcilePhase.Failed || !boundary.boundNamespace)
      {
        await this.statusWriter.patchStatus(clusterTenant, {
          phase: ClusterTenantReconcilePhase.Failed,
          message: boundary.message ?? "boundary provisioning failed",
        });
        return;
      }

      // 3. Fence the bound namespace (PSA restricted), idempotent. Namespace-already-
      //    exists is treated as a converged no-op by __K8sApplyResource.
      await __K8sApplyResource(this.coreApi, _BuildClusterTenantNamespace(boundary.boundNamespace, name), this.log);

      // 4. Per-org domain (DNS + wildcard TLS) — runtime-gated. The provisioner applies
      //    the real Certificate and declares the A records as an external-dns DNSEndpoint,
      //    returning ready:false, skipped:true ONLY when cert-manager AND external-dns are
      //    both genuinely absent; it never throws, so a missing backend cannot fail the reconcile.
      const domain = await this.domainProvisioner.provisionOrgDomain({
        orgName: name,
        boundNamespace: boundary.boundNamespace,
        platformBaseDomain: this.config.ingressDomain,
        vanityDomain: clusterTenant.spec.vanityDomain,
        ingressIp: this.config.ingressIp || undefined,
      });
      if (domain.skipped)
      {
        this.log.info({ name, orgDomain: domain.orgDomain }, "org domain provisioning skipped (no backend); org still reaches ready");
      }

      // 5. Ready — stamp the bound namespace + provisioner + domain status. This is
      //    what unblocks `_ResolveClusterTenant`: an attached openclaw can now resolve
      //    `status.boundNamespace` and land in the fenced namespace.
      await this.statusWriter.patchStatus(clusterTenant, {
        phase: ClusterTenantReconcilePhase.Ready,
        boundNamespace: boundary.boundNamespace,
        provisioner: boundary.provisioner,
        message: undefined,
        orgDomain: domain.orgDomain,
        domainReady: domain.ready,
        domainSkipped: domain.skipped,
      });

      this.log.info({ name, boundNamespace: boundary.boundNamespace }, "cluster tenant ready");
    }
    catch (err)
    {
      this.log.error({ err, name }, "cluster tenant reconcile failed");
      await this.statusWriter.patchStatus(clusterTenant, {
        phase: ClusterTenantReconcilePhase.Failed,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Tear down an org's per-org domain when its ClusterTenant CR is deleted (DOMAIN.T2).
   *
   * Deletes the per-org wildcard Certificate + external-dns DNSEndpoint so external-dns
   * reaps the org's DNS records (it only does so once the owning DNSEndpoint is gone).
   * The bound namespace is re-derived deterministically (`opencrane-<name>`) — the CR's
   * `status` may already be stripped on a delete event, so we never depend on it.
   *
   * Idempotent and fail-soft: `deprovisionOrgDomain` treats missing CRs / absent CRDs as
   * no-ops, and any unexpected error is logged but swallowed — there is no CR left to
   * mark `failed`, and a teardown error must not wedge the watch loop. Namespace GC is
   * the backstop for everything else in the namespace.
   *
   * @param clusterTenant - The ClusterTenant CR being deleted.
   */
  private async deprovision(clusterTenant: ClusterTenantResource): Promise<void>
  {
    const name = clusterTenant.metadata?.name;
    if (!name) return;

    const boundNamespace = clusterTenant.status?.boundNamespace ?? _NamespaceForOrg(name);
    this.log.info({ name, boundNamespace }, "deprovisioning cluster tenant domain");

    try
    {
      await this.domainProvisioner.deprovisionOrgDomain(name, this.config.ingressDomain, boundNamespace);
      this.log.info({ name }, "cluster tenant domain deprovisioned");
    }
    catch (err)
    {
      this.log.error({ err, name }, "cluster tenant domain deprovision failed (namespace GC remains the backstop)");
    }
  }
}

/**
 * Wire all dependencies from a KubeConfig and return a ready-to-start operator.
 *
 * Owns K8s client construction so the operator class depends only on the abstractions
 * it needs. The domain provisioner is the real `DefaultOrgDomainProvisioner`, built by
 * `_BuildOrgDomainProvisioner` from operator config: it applies the per-org Certificate
 * through cert-manager and declares the per-org A records as an external-dns `DNSEndpoint`.
 * It is runtime-gated — cert-manager / DNSEndpoint CRD absence is detected at apply time and
 * surfaced as a skip, never a crash — so it is safe on the dev cluster as-is.
 *
 * @param kc - Resolved KubeConfig.
 * @param config - Operator runtime configuration.
 * @param baseLog - Root logger; scoped to `cluster-tenant-operator` inside.
 */
export function _CreateClusterTenantOperator(kc: k8s.KubeConfig, config: OpenClawTenantOperatorConfig, baseLog: Logger): ClusterTenantOperator
{
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const watch = new k8s.Watch(kc);
  const log = baseLog.child({ component: "cluster-tenant-operator" });

  const statusWriter = new ClusterTenantStatusWriter(customApi, log);
  const domainProvisioner = _BuildOrgDomainProvisioner(customApi, config);

  return new ClusterTenantOperator(watch, customApi, coreApi, statusWriter, domainProvisioner, config, log);
}
