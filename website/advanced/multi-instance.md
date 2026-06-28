# Running multiple instances

::: warning Advanced — most deployments don't need this
A normal OpenCrane install already gives every employee an isolated assistant. You
only need this page if you must run **several completely separate OpenCrane
instances in one Kubernetes cluster** — for example, hosting multiple distinct
customers or business units side by side. If that's not you, skip it.
:::

Run **N strictly-isolated OpenCrane instances in one cluster**, each owning its own
namespace(s), RBAC, and per-instance control plane and operator. Multi-instance mode is
**opt-in** (`multiInstance.enabled=true`). The legacy single-install path is the default
and is unchanged — installing the chart with no extra flags still provisions one instance
*and* its CRDs in a single step.

This document covers the **CRD lifecycle** for a fleet: how CRDs are installed
cluster-wide and decoupled from each per-instance Helm release (multi-instance blocker
**B3**), and the **CRD-version ↔ control-plane/operator compatibility contract** the
fleet uses to plan rolling upgrades.

For the RBAC / watch-namespace isolation defaults, see the `multiInstance.*` block in
`apps/fleet-platform/values.yaml`.

---

## 1. Why CRDs Must Be Decoupled From The Per-Instance Release

CustomResourceDefinitions are **cluster-scoped, singleton objects**. There is exactly one
`tenants.opencrane.io` in a cluster, no matter how many instances run. But each
OpenCrane instance is its own Helm release.

If every per-instance release shipped the CRDs (the default Helm `crds/` behaviour), then:

- **Ownership conflict** — Helm refuses to manage CRDs that another release already owns,
  or silently leaves them unmanaged; the second instance's `helm install` fails or no-ops
  on the CRDs.
- **Upgrade coupling** — bumping one instance's chart would try to mutate the shared CRD
  schema underneath every *other* instance, breaking the "upgrade one instance at a time"
  guarantee the fleet depends on.
- **Teardown hazard** — uninstalling any single instance could delete the CRDs (and, with
  cascading delete, every other instance's custom resources).

The fleet contract is therefore **one CRD bundle, many instances**: the CRDs are installed
**once, cluster-wide**, on their own lifecycle, and every per-instance release is rendered
with `--skip-crds`.

> **Decision (brief Q2):** the API group is **not** per-instanced. All instances share the
> single `opencrane.io` API group and one served CRD bundle version. Instances are isolated
> by **namespace + RBAC + `WATCH_NAMESPACE`**, never by forking the schema. Per-instancing
> the group would multiply the schema surface by the fleet size and break shared tooling
> (the `oc` CLI, control-plane API, awareness layer) that targets one group.

---

## 2. Installing CRDs

### 2.1 Single-install (default — no change)

The default path is untouched. Helm auto-applies everything under `apps/fleet-platform/crds/`
as part of the fleet release, so CRDs land with no extra step:

```bash
apps/fleet-platform/deploy.sh --base-domain <your-domain>
```

Do **not** pass `--skip-crds` on the single-install path — the instance would come up with
no schema to reconcile against.

### 2.2 Multi-instance (opt-in) — install CRDs once, cluster-wide

Install the shared CRD bundle **once per cluster**, before (or independently of) any
instance release. `apps/fleet-platform/crds/` is the single canonical source of the CRDs, so
both paths render byte-identical schemas — there is no second copy to drift.

```bash
# 1. Install / upgrade the shared CRD bundle once for the whole cluster.
kubectl apply -f apps/fleet-platform/crds/
```

`kubectl apply` is intentional rather than `create`: it is idempotent and is also the
**upgrade** verb when the bundle version is rolled forward (see §3). Server-side apply
(`kubectl apply --server-side -f apps/fleet-platform/crds/`) is recommended for large schemas to
avoid the client-side annotation size limit.

The bundle installs the cluster-scoped CRDs in the `opencrane.io` group:

| CRD | Kind | Served version |
|-----|------|----------------|
| `tenants.opencrane.io` | `Tenant` | `v1alpha1` |
| `accesspolicies.opencrane.io` | `AccessPolicy` | `v1alpha1` |
| `mcpservers.opencrane.io` | `MCPServer` | `v1alpha1` |
| `schedules.opencrane.io` | `Schedule` | `v1alpha1` |
| `skillregistries.opencrane.io` | `SkillRegistry` | `v1alpha1` |
| `clustertenants.opencrane.io` | `ClusterTenant` | `v1alpha1` |

To preview exactly what will be applied (e.g. in CI before a fleet rollout), render the
bundle through Helm with CRDs included:

```bash
helm template opencrane-fleet apps/fleet-platform --include-crds \
  | yq 'select(.kind == "CustomResourceDefinition")'
```

### 2.3 Multi-instance — per-instance releases (CRDs skipped)

Each instance is its own pair of releases (one fleet + one or more silos) in its own
namespace, installed with `--skip-crds` so they neither own nor mutate the shared bundle:

```bash
# Fleet instance "acme" — owns opencrane-system-acme, skips the shared CRDs.
helm install oc-acme-fleet apps/fleet-platform \
  --namespace oc-acme-system --create-namespace \
  --skip-crds \
  --set multiInstance.enabled=true \
  --set 'multiInstance.instanceNamespaces={oc-acme-system}' \
  --set operator.watchNamespace=oc-acme-system

# Silo for the acme fleet instance.
helm install oc-acme apps/clustertenant-platform \
  --namespace oc-acme --create-namespace \
  --skip-crds \
  --set multiInstance.enabled=true \
  --set 'multiInstance.instanceNamespaces={oc-acme}'

# Fleet instance "globex" — independent release, same shared CRD bundle.
helm install oc-globex-fleet apps/fleet-platform \
  --namespace oc-globex-system --create-namespace \
  --skip-crds \
  --set multiInstance.enabled=true \
  --set 'multiInstance.instanceNamespaces={oc-globex-system}' \
  --set operator.watchNamespace=oc-globex-system
```

Because the chart's only cluster-scoped singleton was the CRD set, and that is now skipped,
the remaining per-instance objects are namespaced (Deployments, Services, namespaced RBAC
when `multiInstance.rbac=namespaced`) and safe to run side by side.

---

## 3. CRD-Version ↔ Control-Plane / Operator Compatibility Contract

The shared CRD bundle is versioned independently of any single instance's chart release.
The fleet plans rolling upgrades against this matrix.

### 3.1 Definitions

- **CRD bundle version** — the schema version of the 5 CRDs as a set. It tracks the served
  apiVersion plus any backward-compatible schema additions. It is *not* per-CRD; the bundle
  moves as one unit so the fleet has a single number to reason about.
- **Control-plane / operator chart version** — `apps/fleet-platform/Chart.yaml` `appVersion`
  (the image tag the instance runs).

### 3.2 Compatibility matrix

| CRD bundle version | Served apiVersion(s) | Compatible control-plane/operator (`appVersion`) | Status |
|--------------------|----------------------|--------------------------------------------------|--------|
| `v1alpha1` (1) | `opencrane.io/v1alpha1` | `0.1.x` | Current |

Notes:

1. **`v1alpha1` is the current bundle.** All CRDs serve and store `v1alpha1` only; there
   is no conversion webhook yet, so the served and storage versions are the same.
2. As the schema evolves, add a row per bundle version and list the `appVersion` range that
   can both read and write it. A control-plane/operator build is "compatible" with a bundle
   version only if it (a) recognises every required field that bundle marks required, and
   (b) sends no field that bundle's schema rejects under `x-kubernetes-preserve-unknown-fields: false`.

### 3.3 Compatibility rules

1. **Forward-compatible additions only, within a served version.** New *optional* fields may
   be added to `v1alpha1` and applied via `kubectl apply -f apps/fleet-platform/crds/` while
   instances keep running. Older instances ignore fields they don't know about. Never make a
   previously-optional field required, never narrow an enum, and never tighten validation
   within an existing served version — those are breaking and require a new served version.
2. **Breaking changes require a new served version**, served alongside the old one (e.g.
   `v1alpha1` + `v1beta1` both `served: true`, exactly one `storage: true`), plus a
   conversion path, until every instance has migrated off the old version. Only then may the
   old served version be retired.

### 3.4 Upgrade ordering (the fleet rule)

> **CRDs lead, instances follow. Expand before you contract.**

1. **Apply the new CRD bundle first**, cluster-wide:
   `kubectl apply -f apps/fleet-platform/crds/` (or `--server-side`). For additive changes this is
   transparent to running instances.
2. **Roll the instances** one at a time (re-run the relevant deploy script with `--reuse-values`).
   Each instance must run an `appVersion` listed as compatible with the **new** bundle
   in §3.2. A canary instance first, then the rest, lets the fleet halt on regression.
3. **Never** let an instance run an `appVersion` newer than the cluster's applied CRD bundle
   supports — that instance would emit fields the schema rejects. If a rollback is needed,
   roll the *instances* back; leave the additive CRD bundle in place (it is a superset and
   stays compatible with the older instances).
4. For a **breaking** bundle version: apply the new bundle (both versions served), roll all
   instances to an `appVersion` that writes the new storage version, run the migration, then
   apply the contracting bundle that drops the old served version — last.

This ordering is what lets the fleet upgrade the shared schema once and migrate instances
independently, which is the whole point of decoupling CRDs from the per-instance release.

---

## 4. Validation

A note on Helm's flags, because they behave differently for `template` vs `install`:

- **`--include-crds`** controls whether `helm template` *renders* the `crds/` directory
  into its output. Without it, `helm template` emits **no** CRDs (this is rendering only;
  it does not reflect what `helm install` applies).
- **`--skip-crds`** controls whether `helm install` / `helm upgrade` **applies** the CRDs to
  the cluster. It is an *apply-time* flag and has **no effect on `helm template` output** —
  so the decoupling in §2.3 is verified at install time (against a cluster), while the
  commands below verify the *contents* of each path.

```bash
# Fleet chart CRD contents: verify the CRDs are present.
# `apps/fleet-platform/deploy.sh` applies these automatically (no flag needed).
helm template opencrane-fleet apps/fleet-platform --include-crds \
  | grep -c 'kind: CustomResourceDefinition'

# The shared CRD bundle (what `kubectl apply -f apps/fleet-platform/crds/` installs).
ls apps/fleet-platform/crds/*.yaml | wc -l

# Per-instance fleet release CONTENTS excluding CRDs (what `--skip-crds` applies at
# install time): render the namespaced objects only, no --include-crds. Expect 0 CRDs.
helm template oc-acme-fleet apps/fleet-platform \
  --namespace oc-acme-system \
  --set multiInstance.enabled=true \
  --set 'multiInstance.instanceNamespaces={oc-acme-system}' \
  --set operator.watchNamespace=oc-acme-system \
  | grep -c 'kind: CustomResourceDefinition'   # → 0

# At install time, prove --skip-crds is honoured against a real (or kind) cluster:
helm install oc-acme-fleet apps/fleet-platform \
  --namespace oc-acme-system --create-namespace --skip-crds \
  --set multiInstance.enabled=true --dry-run=server \
  | grep -c 'kind: CustomResourceDefinition'   # → 0 (CRDs not in the release manifest)
```

## 4. Reference example + conformance test (MI.7)

Two ready-to-use instance value files demonstrate strict isolation in one cluster:

- `libs/k8s-platform/values/multi-instance/oc-acme.yaml`
- `libs/k8s-platform/values/multi-instance/oc-globex.yaml`

Each enables `multiInstance` with namespaced RBAC, fail-closed watch scoping, and a
per-instance cert Issuer + SecretStore, scoped to its own namespace.

Validate the static isolation guarantees (no cluster — uses `helm template`):

```bash
libs/k8s-platform/tests/multi-instance-conformance.sh
```

It asserts, per instance: fail-closed watch scope, namespaced RBAC with no
cross-instance ClusterRole (only the legitimately cluster-scoped TokenReview), no
`ClusterIssuer`/`ClusterSecretStore`, a cross-instance default-deny NetworkPolicy,
and no references to the other instance. The **live** acceptance criteria (brief
§5.2–§5.5: dueling-operator, RBAC `can-i` denial, pod→service NetworkPolicy denial,
and teardown isolation) need a real cluster + CNI + ACME and are documented at the
end of that script as the live-infra seam.

## 5. ClusterTenant — the customer / isolation unit (Track CT)

Multi-instance (§1–4) gives you N isolated *instances* in one cluster. **`ClusterTenant`**
makes the *customer* a first-class, API-managed resource on top of that, so isolation and
resource gating are modeled and enforced rather than implied by how you wrote the values files.

> **Two tenant concepts — keep them straight.** A **ClusterTenant** is the *customer /
> isolation unit* (cluster-scoped `clustertenants.opencrane.io`): it owns a namespace, a
> `ResourceQuota`/`LimitRange`, a compute `isolationTier`, and an org host `<org>.<base>`. A
> **UserTenant** is the *per-user OpenClaw agent gateway* — the openclaw / `Tenant` CRD
> (`tenant.opencrane.io`); "UserTenant" is the canonical doc name, while the CRD kind is still
> `Tenant` in code. All users in an org connect through the org's single host `<org>.<base>`;
> the identity-routing proxy (in the operator) routes each session to its pod — there are no
> per-user subdomains. See the authoritative
> [Tenancy Model](https://github.com/italanta/opencrane/blob/main/docs/agents/cluster-architecture.md#tenancy-model--clustertenant-vs-usertenant)
> for the full table and DNS hierarchy.

> **The invariant the resource makes enforceable: one customer = one `ClusterTenant` = one
> instance.** A **UserTenant** (the openclaw / `Tenant` CR) attaches to exactly one
> `ClusterTenant`; the operator deploys it into that customer's bound namespace and fences it there.

### 5.1 Default stays single-install (opt-in)

`ClusterTenant` machinery is **opt-in** and changes nothing for a zero-config install. The
cluster-scoped `clustertenants.opencrane.io` CRD installs with the chart (installing a CRD is
inert — nothing creates a `ClusterTenant`), and a UserTenant (openclaw / `Tenant` CR) with no
`spec.clusterTenantRef` deploys into the install namespace exactly as before. `helm template`
with no flags renders **no** ClusterTenant env, namespace, quota, or scheduling. You opt in per
customer by creating a `ClusterTenant` and pointing UserTenants at it with `spec.clusterTenantRef`.

### 5.2 Isolation tiers

| Tier | What it gives the customer | How it's served |
|------|----------------------------|-----------------|
| `shared` | A fenced namespace, bin-packed onto shared nodes (max density). | Native — built-in `SharedClusterProvisioner`. |
| `dedicatedNodes` | A fenced namespace **plus** pods pinned to the customer's own node pool (`nodeSelector`/`tolerations`). | Native — operator stamps scheduling; machines via GKE NAP/ComputeClass, not OpenCrane. |
| `dedicatedCluster` | The customer's own kube-apiserver. | **External provisioner only** — see §5.4. Rejected `422 TIER_UNAVAILABLE` unless a backend advertises it. |

When a customer is opted in, the operator ensures the per-`ClusterTenant` namespace
(labelled `pod-security.kubernetes.io/enforce: restricted`), derives a `ResourceQuota` +
`LimitRange` from `spec.resources.quota` ({cpu, memory, pods, storage, gpu}), and stamps
scheduling from `spec.compute`. The operator is the sole pod-creator, so no admission webhook
is needed to enforce this.

### 5.3 Managing cluster tenants (API-first)

Everything is on the control-plane API (`/api/v1/cluster-tenants`) and mirrored by the CLI —
the frontend is just another client, never a privileged path:

```bash
oc cluster-tenant create acme --display-name "Acme Corp" \
  --tier dedicatedNodes --compute dedicated --node-pool acme-pool \
  --quota-cpu 8 --quota-memory 16Gi --quota-pods 40
oc cluster-tenant list
oc cluster-tenant show acme
oc cluster-tenant status acme
```

### 5.4 Plugging in a `dedicatedCluster` backend without forking (AGPL-clean)

The `dedicatedCluster` tier is served by an **out-of-process** provisioner webhook, never by
in-tree vendor code. The control plane POSTs a vendor-neutral `ClusterTenantProvisionRequest`
(published in the MIT `libs/contracts`) to a configured HTTPS endpoint and reads back a status
plus a kubeconfig **Secret reference** — the credential material never crosses the wire inline.
A private vendor (e.g. a hosted-control-plane product) implements that contract in their own
service; nothing vendor-specific lives in the AGPL tree. See
`enterprise-needs.md` for the licensing rationale and the Kamaji parking note.

Configure it via Helm — leave it unset and `dedicatedCluster` stays unavailable (fail-closed):

```yaml
clusterTenant:
  provisionerWebhook:
    url: https://provisioner.internal.example/api   # must be https:// — refused otherwise
    id: my-backend
    existingSecret: cluster-tenant-provisioner
    secretKey: CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN
```

The control plane refuses a non-`https://` URL at startup so the bearer token is never sent in
plaintext.

### 5.5 Validation

`helm template` proves the opt-in gate statically: with no flags the chart renders the
`ClusterTenant` CRD but **no** provisioner env on the control-plane Deployment; setting
`clusterTenant.provisionerWebhook.url` renders the env block. The per-`ClusterTenant` namespace,
quota, and scheduling are reconciled at runtime by the operator (the live-infra seam), and the
conformance script (`libs/k8s-platform/tests/multi-instance-conformance.sh`) carries the in-cluster
assertions for them (CT.5a–CT.5d).
