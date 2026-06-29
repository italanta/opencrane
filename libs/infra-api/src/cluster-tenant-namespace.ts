import type * as k8s from "@kubernetes/client-node";

import { LINKERD_INJECT_ANNOTATION, LINKERD_INJECT_ENABLED } from "./linkerd.js";

/**
 * Build the per-ClusterTenant Namespace, labelled for Pod Security Admission
 * (PSA) `baseline` enforcement.
 *
 * This is the isolation boundary for the opt-in multi-tenant path: every
 * openclaw attached to a ClusterTenant lands in this namespace, and the PSA
 * labels make the kubelet/api-server reject any pod that violates the
 * `baseline` profile (privileged containers, host namespaces/path/ports, etc.).
 * The warn/audit labels are pinned to the same profile/version so policy drift is
 * surfaced in API responses and the audit log even before a reject fires.
 * `baseline` (not `restricted`) because the silo runs 3rd-party planes that can't
 * meet `restricted` — see the labels block below for the rationale + the revisit TODO.
 *
 * Ref-less openclaws never reach this builder — they deploy into the install
 * namespace exactly as before, so default behaviour is unchanged.
 *
 * @param namespace - The bound namespace name resolved from the ClusterTenant.
 * @param clusterTenantName - Parent ClusterTenant name, recorded as a label for traceability.
 * @param linkerdInject - When true, annotate the namespace for Linkerd mesh injection so
 *   workloads get the sidecar/identity (S5; default off — gated by `linkerdMeshEnabled`).
 * @returns A Namespace object carrying the standard PSA enforce/warn/audit labels.
 * @see https://kubernetes.io/docs/concepts/security/pod-security-admission/ - PSA reference
 */
export function _BuildClusterTenantNamespace(
  namespace: string,
  clusterTenantName: string,
  linkerdInject: boolean = false,
): k8s.V1Namespace
{
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      // Linkerd mesh injection (S5) — only stamped when the gate is on, so a cluster
      // without Linkerd is unaffected (an unrecognised annotation is otherwise inert).
      ...(linkerdInject ? { annotations: { [LINKERD_INJECT_ANNOTATION]: LINKERD_INJECT_ENABLED } } : {}),
      labels: {
        "app.kubernetes.io/part-of": "opencrane",
        "app.kubernetes.io/managed-by": "opencrane-fleet-manager",
        "opencrane.io/cluster-tenant": clusterTenantName,
        // Pod Security Admission — enforce the `baseline` profile (reject), mirrored on
        // warn/audit. `baseline` keeps the cross-tenant boundaries (no privileged containers,
        // host namespaces, hostPath, host ports), but — unlike `restricted` — does not force
        // every pod non-root/drop-all-caps/seccomp. That stricter level is infeasible here: a
        // silo runs 3rd-party planes (obot ships an embedded root Postgres + no USER, cognee
        // runs as root) the chart can't make compliant, so `restricted` would reject the whole
        // silo. TODO(security): revisit — per-tier PSS (restricted on dedicatedNodes tiers),
        // a leaner non-root MCP gateway to replace obot, and per-pod hardened securityContext
        // on the pods we control. See the silo-org-role / strong-siloes memory.
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/warn": "baseline",
        "pod-security.kubernetes.io/warn-version": "latest",
        "pod-security.kubernetes.io/audit": "baseline",
        "pod-security.kubernetes.io/audit-version": "latest",
      },
    },
  };
}
