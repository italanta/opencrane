-- Migration 0014: Native ClusterTenant resource (CT.1)
--
-- Introduces the first-class customer / isolation unit that sits above the
-- Tenant/openclaw CRD. Persisted alongside the cluster-scoped ClusterTenant CRD
-- (dual-write, like tenants/access_policies). Additive and opt-in: single-install
-- deployments carry one synthetic "default" cluster tenant, so this table stays
-- empty until multi-tenancy is opted in.

-- 1. Closed-set enums (DB values mirror the @map labels in schema.prisma and the
--    ClusterTenant*-tier/mode enums in libs/contracts).
CREATE TYPE "ClusterTenantIsolationTier" AS ENUM ('shared', 'dedicatedNodes', 'dedicatedCluster');
CREATE TYPE "ClusterTenantComputeMode" AS ENUM ('shared', 'dedicated');

-- 2. The customer/isolation record. quota is JSONB ({cpu,memory,pods,storage,gpu});
--    phase mirrors the CRD status subresource lifecycle.
CREATE TABLE "cluster_tenants" (
  "name"            TEXT NOT NULL,
  "display_name"    TEXT NOT NULL,
  "isolation_tier"  "ClusterTenantIsolationTier" NOT NULL DEFAULT 'shared',
  "compute_mode"    "ClusterTenantComputeMode" NOT NULL DEFAULT 'shared',
  "node_pool"       TEXT,
  "quota"           JSONB,
  "phase"           TEXT NOT NULL DEFAULT 'pending',
  "message"         TEXT,
  "bound_namespace" TEXT,
  "provisioner"     TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cluster_tenants_pkey" PRIMARY KEY ("name")
);
