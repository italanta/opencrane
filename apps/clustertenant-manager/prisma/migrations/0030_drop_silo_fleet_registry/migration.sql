-- Stage 4: the silo (clustertenant-manager) no longer owns the fleet registry — ClusterTenant
-- lifecycle + billing moved to the fleet-manager's own database. Drop the relocated tables and
-- their now-unused enums, and drop the org_memberships → cluster_tenants FK so OrgMembership's
-- `cluster_tenant` becomes a soft string reference (OrgMembership stays as the silo's local
-- read-model for /auth/me).

-- 1. Drop the cascade FK from org_memberships to the relocated cluster_tenants table.
ALTER TABLE "org_memberships" DROP CONSTRAINT IF EXISTS "org_memberships_cluster_tenant_fkey";

-- 2. Drop the relocated fleet-registry tables.
DROP TABLE IF EXISTS "billing_accounts";
DROP TABLE IF EXISTS "cluster_tenants";

-- 3. Drop the now-unused ClusterTenant enums (only the dropped table referenced them).
DROP TYPE IF EXISTS "ClusterTenantIsolationTier";
DROP TYPE IF EXISTS "ClusterTenantComputeMode";
