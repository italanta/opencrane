import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../config.js";
import { __K8sApplyResource } from "../infra/k8s.js";
import { _RunWatchLoop, K8sWatchEventType } from "../shared/watch-runner.js";
import { CLUSTER_TENANT_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "../shared/crd-constants.js";
import { _BuildClusterTenantNamespace } from "../tenants/deploy/index.js";
import type { ClusterTenantResource } from "../tenants/internal/cluster-tenant-resolution.types.js";

import { ClusterTenantStatusWriter } from "./internal/cluster-tenant-status-writer.js";
import { _NamespaceForOrg, _ProvisionBoundary } from "./internal/shared-cluster.provisioner.js";
import { ClusterTenantReconcilePhase } from "./internal/shared-cluster.provisioner.types.js";
import type { OrgDomainProvisioner } from "./internal/org-domain-provisioner.types.js";
import { _BuildOrgDomainProvisioner } from "./internal/org-domain.provisioner.factory.js";

/**
 * Legacy annotation the control plane used to stamp with the org owner's email,
 * before owner identity moved to the validated `spec.owner` field. Read only as a
 * fallback so CRs created by an older control plane (not yet backfilled) still seed
 * their default Tenant during rollout; new CRs carry `spec.owner` instead.
 */
const _LEGACY_OWNER_EMAIL_ANNOTATION = "opencrane.io/owner-email";

/** Suffix appended to an org's name to form its auto-seeded first workspace Tenant. */
const _DEFAULT_TENANT_SUFFIX = "-default";

/** Whether a Kubernetes API error is a 409 AlreadyExists across the common error shapes. */
function _IsAlreadyExistsError(err: unknown): boolean
{
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; code?: unknown; body?: { code?: unknown } };
  if (e.statusCode === 409 || e.code === 409) return true;
  return typeof e.body === "object" && e.body !== null && (e.body as { code?: unknown }).code === 409;
}

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
   * Per-org reconcile coalescing. The watch runner dispatches event handlers
   * fire-and-forget, so on every watch reconnect K8s replays ALL CRs as `ADDED`
   * concurrently. Without a guard those reconciles pile up faster than they drain
   * when the API server is throttling (APF 429s) — the unbounded growth that ends
   * in `OOMKilled`, and overlapping namespace-creates for one org race each other.
   *
   * `running` holds the org names with a drain loop in progress; `pending` holds the
   * latest CR awaiting reconcile per name. An event for a name already running only
   * updates `pending` (coalesced — reconcile is idempotent, so collapsing several
   * queued events into the newest one is correct), bounding in-flight work to one
   * reconcile per org instead of one per event.
   */
  private readonly running = new Set<string>();

  /** Latest CR awaiting reconcile per org name (see {@link running}). */
  private readonly pending = new Map<string, ClusterTenantResource>();

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
        await this.dispatchReconcile(clusterTenant);
        break;
      // Delete: namespace GC reclaims the namespaced Certificate/DNSEndpoint CRs, but
      // external-dns only reaps the records it owns once the DNSEndpoint is actually
      // gone — so we explicitly deprovision the per-org domain rather than relying on
      // GC ordering. The bound namespace and attached openclaws are torn down by their
      // own lifecycles. Drop any queued reconcile first so a coalesced event cannot
      // re-create what we are tearing down.
      case K8sWatchEventType.Deleted:
        this.pending.delete(name);
        await this.deprovision(clusterTenant);
        break;
    }
  }

  /**
   * Dispatch a reconcile through the per-org coalescing guard (see {@link running}).
   *
   * Records the CR as the org's latest desired state, then — unless a drain loop is
   * already running for that name — drains `pending` to convergence one reconcile at a
   * time. This serialises reconciles per org (no overlapping namespace-creates) and
   * bounds concurrent work to one-per-org, so a watch-reconnect storm or a throttled
   * API server can never let fire-and-forget handlers accumulate into an OOM.
   *
   * @param clusterTenant - The CR from the watch event to reconcile.
   */
  private async dispatchReconcile(clusterTenant: ClusterTenantResource): Promise<void>
  {
    const name = clusterTenant.metadata?.name;
    if (!name) return;

    // Always record the newest desired state; a running loop will pick it up.
    this.pending.set(name, clusterTenant);
    if (this.running.has(name)) return;

    this.running.add(name);
    try
    {
      while (this.pending.has(name))
      {
        const next = this.pending.get(name)!;
        this.pending.delete(name);
        await this.reconcile(next);
      }
    }
    finally
    {
      this.running.delete(name);
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

    // 0. Skip the expensive path when an already-ready org's spec is unchanged.
    //    `metadata.generation` bumps only on a spec change (status writes do not), so a
    //    watch replay of a converged CR has `observedGeneration === generation`. Without
    //    this guard every watch reconnect re-applies the namespace + re-runs domain
    //    provisioning + re-seeds the tenant for every org at once — the API-server 429
    //    storm + memory growth that crash-loops the operator. A reconcile with no
    //    generation (older CRs) still runs, then stamps observedGeneration below.
    const generation = clusterTenant.metadata?.generation;
    if (clusterTenant.status?.phase === ClusterTenantReconcilePhase.Ready
        && typeof generation === "number"
        && clusterTenant.status?.observedGeneration === generation)
    {
      this.log.debug({ name, generation }, "cluster tenant already reconciled at this generation; skipping");
      return;
    }

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
        // Record the generation we just converged so the guard at the top of reconcile()
        // skips the next watch replay of this unchanged CR. A later spec edit bumps
        // generation and re-arms a full reconcile.
        observedGeneration: clusterTenant.metadata?.generation,
      });

      this.log.info({ name, boundNamespace: boundary.boundNamespace }, "cluster tenant ready");

      // 6. Seed the org's first workspace Tenant now that the org is ready and its
      //    namespace exists. Idempotent + fail-soft: a re-reconcile re-applies the same
      //    `<org>-default` Tenant (AlreadyExists is a no-op), and a seed failure is logged
      //    but never fails the reconcile, so the org cannot be wedged out of `ready`.
      await this.ensureDefaultTenant(clusterTenant);
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
   * Seed the org's first workspace Tenant once it is ready, attributed to the org owner.
   *
   * Closes the "ready org with no workspace" gap: provisioning creates the org (+owner
   * membership) but no pod, so a freshly-provisioned customer would land in an empty
   * console. On the org's reconcile to `ready` — when its bound namespace exists — this
   * applies a `<org>-default` Tenant whose `clusterTenantRef` points back at the org.
   *
   * Idempotent: a re-reconcile re-applies the same Tenant and treats AlreadyExists (409)
   * as a converged no-op (it is created in the operator's watch namespace, like every
   * other Tenant CR). Fail-soft: any other error is logged but never thrown, so a seed
   * hiccup cannot wedge the org out of `ready`; the next reconcile retries.
   *
   * The owner's email arrives via the CR's `spec.owner.email` (the operator has no DB
   * access), falling back to the legacy `opencrane.io/owner-email` annotation for CRs an
   * older control plane created before the field existed. When it is absent — the dev-auth
   * path carries only a subject, no email — the seed is skipped with a warning.
   *
   * @param clusterTenant - The ready ClusterTenant whose default Tenant is ensured.
   */
  private async ensureDefaultTenant(clusterTenant: ClusterTenantResource): Promise<void>
  {
    const orgName = clusterTenant.metadata!.name!;
    const ownerEmail = clusterTenant.spec.owner?.email?.trim()
      || clusterTenant.metadata?.annotations?.[_LEGACY_OWNER_EMAIL_ANNOTATION]?.trim();
    if (!ownerEmail)
    {
      this.log.warn({ name: orgName }, "no owner email on cluster tenant (spec.owner.email / legacy annotation both absent); skipping default tenant seed");
      return;
    }

    // Tenant CRs live in the operator's watch namespace (the TenantOperator watches there),
    // falling back to the operator's own namespace when watching all namespaces.
    const namespace = this.config.watchNamespace || this.config.operatorNamespace;
    const tenantName = `${orgName}${_DEFAULT_TENANT_SUFFIX}`;
    const tenantCr = {
      apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
      kind: "Tenant",
      metadata: { name: tenantName, namespace },
      spec: {
        displayName: `${clusterTenant.spec.displayName ?? orgName} workspace`,
        email: ownerEmail,
        clusterTenantRef: orgName,
      },
    };

    try
    {
      await this.customApi.createNamespacedCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        namespace,
        plural: TENANT_CRD_PLURAL,
        body: tenantCr,
      });
      this.log.info({ name: orgName, tenantName, namespace }, "seeded default tenant for org");
    }
    catch (err)
    {
      if (_IsAlreadyExistsError(err))
      {
        this.log.debug({ name: orgName, tenantName }, "default tenant already exists; nothing to seed");
        return;
      }
      this.log.warn({ err, name: orgName, tenantName }, "failed to seed default tenant (org stays ready; will retry on next reconcile)");
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
