import type { KubernetesObject } from "@kubernetes/client-node";

/**
 * Aggregate resource ceiling read from a parent ClusterTenant. Mirrors the
 * `spec.resources.quota` block of the cluster-scoped CRD; the operator stamps
 * these as a ResourceQuota/LimitRange in CT.5 (out of scope here).
 */
export interface ClusterTenantQuotaView
{
  /** Total CPU the customer may request (e.g. "4", "500m"). */
  cpu?: string;
  /** Total memory the customer may request (e.g. "8Gi"). */
  memory?: string;
  /** Maximum number of pods the customer may run. */
  pods?: number;
  /** Total persistent storage the customer may claim (e.g. "100Gi"). */
  storage?: string;
  /** Total GPUs the customer may request. */
  gpu?: number;
}

/**
 * Compute placement policy read from a parent ClusterTenant. Mirrors the
 * `spec.compute` block of the cluster-scoped CRD; the operator stamps the
 * resulting nodeSelector/tolerations in CT.5 (out of scope here).
 */
export interface ClusterTenantComputeView
{
  /** Whether the customer shares nodes ("shared") or pins to a pool ("dedicated"). */
  mode?: string;
  /** Dedicated node pool name; present when mode is "dedicated". */
  nodePool?: string;
}

/**
 * Operator-local view of a parent ClusterTenant custom resource. Only the
 * fields the reconcile path consumes are typed; the full contract shape lives
 * in `@opencrane/contracts` and is owned by the control plane.
 */
export interface ClusterTenantResource extends KubernetesObject
{
  /** Desired state of the cluster tenant. */
  spec: {
    /** Human-readable customer name. */
    displayName?: string;
    /** Isolation strength chosen for this customer. */
    isolationTier?: string;
    /** Compute placement policy stamped onto attached openclaw pods. */
    compute?: ClusterTenantComputeView;
    /** Resource gating for the customer's namespace. */
    resources?: {
      /** Aggregate quota enforced over the customer's namespace. */
      quota?: ClusterTenantQuotaView;
    };
  };

  /** Observed state; absent until first reconciled by the control plane. */
  status?: {
    /** Current lifecycle phase (pending|provisioning|ready|failed). */
    phase?: string;
    /** Human-readable detail, set on failure or transitional states. */
    message?: string;
    /** Namespace bound to this customer once provisioned. */
    boundNamespace?: string;
    /** Identifier of the provisioner that owns this customer's boundary. */
    provisioner?: string;
  };
}

/**
 * Result of resolving the parent ClusterTenant for an openclaw. Always carries
 * a `targetNamespace`; the optional `clusterTenant` is present only when a
 * `spec.clusterTenantRef` was set and resolved (the opt-in multi-tenant path).
 */
export interface ClusterTenantResolutionResult
{
  /** Namespace the openclaw's child resources must be deployed into. */
  targetNamespace: string;
  /** Whether a parent ClusterTenant was explicitly referenced and resolved. */
  ref: boolean;
  /** Resolved parent ClusterTenant, when `ref` is true. Quota/compute consumed in CT.5. */
  clusterTenant?: ClusterTenantResource;
}
