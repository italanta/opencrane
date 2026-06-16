-- Migration 0016: project the Tenant→ClusterTenant link (WOI.2)
--
-- The Tenant CRD already carries `spec.clusterTenantRef` (CT.4); this projects it
-- into the SQL read model so the `/api/v1/tenants` API can surface the link and
-- filter on it server-side (`GET /tenants?clusterTenantRef=<name>`), instead of a
-- federated frontend mapping `team` → ref and filtering client-side. Additive +
-- backward-compatible: existing rows keep cluster_tenant_ref NULL (the default,
-- single-instance path) until a tenant is attached to a ClusterTenant.

ALTER TABLE "tenants"
  ADD COLUMN "cluster_tenant_ref" TEXT;
