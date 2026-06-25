-- Migration 0026: per-org OIDC client_id on the ClusterTenant (S3b)
--
-- S3 provisions a dedicated Zitadel Organization + OIDC app per ClusterTenant and
-- persists the org id, app id, and redirect URI. The login flow still uses a single
-- shared client, so it cannot scope login to one org's user pool. Capture the OIDC
-- app's client_id (returned by the live app-create response) so host→CT→client
-- resolution can authorize against the org-scoped client. Nullable so existing rows
-- and the unconfigured (no-Zitadel) path are unaffected.

ALTER TABLE "cluster_tenants"
  ADD COLUMN "zitadel_client_id" TEXT;
