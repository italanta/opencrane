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
    /** Optional customer-vanity domain CNAMEd onto the org apex (`<name>.<platformBase>`); an overlay, not the org identity. */
    vanityDomain?: string;
    /** Isolation strength chosen for this customer. */
    isolationTier?: string;
    /** Compute placement policy stamped onto attached openclaw pods. */
    compute?: ClusterTenantComputeView;
    /** Resource gating for the customer's namespace. */
    resources?: {
      /** Aggregate quota enforced over the customer's namespace. */
      quota?: ClusterTenantQuotaView;
    };
    /**
     * Org owner identity, projected by the control plane (the IAM authority) as first-class
     * desired state. The operator attributes the org's auto-seeded default Tenant to this
     * owner; it has no DB access, so the CR spec is the only channel for the owner identity.
     */
    owner?: {
      /** The owner's OIDC subject (`sub`). */
      subject?: string;
      /** The owner's IdP-verified email; becomes the default Tenant's contact email. */
      email?: string;
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
    /**
     * `metadata.generation` the reconciler last drove to `ready`. The API server bumps
     * `generation` only on a spec change (status writes do not), so a watch replay of an
     * unchanged, already-ready CR has `observedGeneration === metadata.generation` and is
     * skipped — the canonical controller guard that prevents re-provisioning every watch
     * cycle (the namespace-create storm that 429s the API server and OOMs the operator).
     */
    observedGeneration?: number;
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
