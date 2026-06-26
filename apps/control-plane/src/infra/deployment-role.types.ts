/**
 * The deployment role of a control-plane process (S6 / ADR 0002).
 *
 * The same control-plane image runs in two distinct topological positions, selected by the
 * `OPENCRANE_CONTROL_PLANE_ROLE` env (set by Helm from `deploymentRole`):
 *
 *  - `central` — the single, shared super-admin control-plane. Cross-silo, fleet-level: it
 *    manages the lifecycle of ClusterTenants (create/delete), their membership, the platform's
 *    Zitadel SA key, and platform DNS. It serves NO tenant-facing per-silo surface, because it
 *    belongs to no single silo. Central + Zitadel are the only shared components (ADR 0002, dec. 1).
 *  - `silo` — a per-ClusterTenant control-plane, one instance dedicated to a single silo. It serves
 *    only that silo's tenant-facing surface (tenants, policies, skills, model-routing, sharing, …)
 *    against its own per-CT database. A single-cluster install is a silo-of-one and also runs as
 *    `silo` (it needs the runtime planes, which Helm renders only for `isSilo`).
 *
 * Splitting the surface by role is what retires the resolution-ambiguity machinery: a silo
 * control-plane serves exactly one ClusterTenant, so there is no caller→silo inference to make,
 * and a central control-plane never sees a tenant-facing request at all.
 */
export type ControlPlaneRole = "central" | "silo";
