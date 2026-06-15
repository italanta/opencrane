import type * as k8s from "@kubernetes/client-node";

/**
 * Build the per-ClusterTenant Namespace, labelled for Pod Security Admission
 * (PSA) `restricted` enforcement.
 *
 * This is the isolation boundary for the opt-in multi-tenant path: every
 * openclaw attached to a ClusterTenant lands in this namespace, and the PSA
 * labels make the kubelet/api-server reject any pod that violates the
 * `restricted` profile (privileged containers, host namespaces, etc.). The
 * warn/audit labels are pinned to the same profile/version so policy drift is
 * surfaced in API responses and the audit log even before a reject fires.
 *
 * Ref-less openclaws never reach this builder — they deploy into the install
 * namespace exactly as before, so default behaviour is unchanged.
 *
 * @param namespace - The bound namespace name resolved from the ClusterTenant.
 * @param clusterTenantName - Parent ClusterTenant name, recorded as a label for traceability.
 * @returns A Namespace object carrying the standard PSA enforce/warn/audit labels.
 * @see https://kubernetes.io/docs/concepts/security/pod-security-admission/ - PSA reference
 */
export function _BuildClusterTenantNamespace(namespace: string, clusterTenantName: string): k8s.V1Namespace
{
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-operator",
        "opencrane.io/cluster-tenant": clusterTenantName,
        // Pod Security Admission — enforce the `restricted` profile (reject),
        // and mirror it on warn/audit so violations are also logged/surfaced.
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/warn-version": "latest",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/audit-version": "latest",
      },
    },
  };
}
