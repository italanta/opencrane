-- Phase 4 backend foundation: groups, generic grants, MCP catalog, skill catalog,
-- and third-party source inventory. Keep this manual migration explicit so the
-- rollout order stays stable even while Helm/UI slices land independently.

-- 1. Groups + generic grants power the deny-wins compiler for awareness, MCP, and skills.
CREATE TYPE "grant_scope" AS ENUM ('org', 'department', 'project', 'personal');
CREATE TYPE "grant_subject_type" AS ENUM ('group', 'tenant', 'user');
CREATE TYPE "grant_access" AS ENUM ('allow', 'deny');
CREATE TYPE "grant_payload_type" AS ENUM ('awareness', 'mcp-server', 'skill-bundle');

CREATE TABLE "groups" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "description" TEXT,
  "members" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "groups_name_key" ON "groups"("name");
CREATE INDEX "groups_scope_idx" ON "groups"("scope");

CREATE TABLE "grants" (
  "id" TEXT NOT NULL,
  "payload_type" "grant_payload_type" NOT NULL,
  "payload_id" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "subject_type" "grant_subject_type" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "access" "grant_access" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "group_id" TEXT,
  "mcp_server_id" TEXT,
  "skill_bundle_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "grants_payload_type_payload_id_idx" ON "grants"("payload_type", "payload_id");
CREATE INDEX "grants_subject_type_subject_id_idx" ON "grants"("subject_type", "subject_id");

-- 2. MCP catalog tables replace the AccessPolicy-only allow/deny path.
CREATE TYPE "mcp_server_transport" AS ENUM ('streamable-http', 'sse', 'websocket');
CREATE TYPE "mcp_server_status" AS ENUM ('active', 'degraded', 'draft');

CREATE TABLE "mcp_servers" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "endpoint" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "transport" "mcp_server_transport" NOT NULL,
  "status" "mcp_server_status" NOT NULL DEFAULT 'draft',
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_id" TEXT,
  "last_synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mcp_servers_name_key" ON "mcp_servers"("name");
CREATE INDEX "mcp_servers_scope_idx" ON "mcp_servers"("scope");

CREATE TABLE "mcp_server_grants" (
  "id" TEXT NOT NULL,
  "mcp_server_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "subject_type" "grant_subject_type" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "access" "grant_access" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "group_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mcp_server_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mcp_server_grants_grant_id_key" ON "mcp_server_grants"("grant_id");
CREATE INDEX "mcp_server_grants_mcp_server_id_idx" ON "mcp_server_grants"("mcp_server_id");

CREATE TABLE "mcp_server_credentials" (
  "id" TEXT NOT NULL,
  "mcp_server_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "secret_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mcp_server_credentials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mcp_server_credentials_mcp_server_id_idx" ON "mcp_server_credentials"("mcp_server_id");

-- 3. Skill catalog tables replace the filesystem-only skills router.
CREATE TYPE "skill_bundle_status" AS ENUM ('published', 'review', 'draft');
CREATE TYPE "skill_promotion_status" AS ENUM ('proposed', 'approved', 'rejected');

CREATE TABLE "skill_bundles" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "version" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "status" "skill_bundle_status" NOT NULL DEFAULT 'draft',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_id" TEXT,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_bundles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "skill_bundles_name_version_digest_key" ON "skill_bundles"("name", "version", "digest");
CREATE INDEX "skill_bundles_scope_idx" ON "skill_bundles"("scope");

CREATE TABLE "skill_entitlements" (
  "id" TEXT NOT NULL,
  "skill_bundle_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "scope" "grant_scope" NOT NULL,
  "subject_type" "grant_subject_type" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "access" "grant_access" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "group_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_entitlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "skill_entitlements_grant_id_key" ON "skill_entitlements"("grant_id");
CREATE INDEX "skill_entitlements_skill_bundle_id_idx" ON "skill_entitlements"("skill_bundle_id");

CREATE TABLE "skill_promotions" (
  "id" TEXT NOT NULL,
  "skill_bundle_id" TEXT NOT NULL,
  "from_scope" "grant_scope" NOT NULL,
  "to_scope" "grant_scope" NOT NULL,
  "promoted_by" TEXT NOT NULL,
  "status" "skill_promotion_status" NOT NULL DEFAULT 'proposed',
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_promotions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "skill_promotions_skill_bundle_id_idx" ON "skill_promotions"("skill_bundle_id");

-- 4. Third-party sources track discovery separately from install/entitlement decisions.
CREATE TYPE "third_party_source_kind" AS ENUM ('mcp-registry', 'anthropic-skills', 'git-repository', 'manual-upload');
CREATE TYPE "third_party_source_status" AS ENUM ('healthy', 'syncing', 'error', 'pending-approval');
CREATE TYPE "third_party_source_item_kind" AS ENUM ('mcp-server', 'skill-bundle');

CREATE TABLE "third_party_sources" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "third_party_source_kind" NOT NULL,
  "status" "third_party_source_status" NOT NULL DEFAULT 'pending-approval',
  "origin_url" TEXT NOT NULL,
  "sync_mode" TEXT NOT NULL,
  "last_synced_at" TIMESTAMP(3),
  "next_run_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "third_party_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "third_party_sources_name_key" ON "third_party_sources"("name");

CREATE TABLE "third_party_source_items" (
  "id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "kind" "third_party_source_item_kind" NOT NULL,
  "name" TEXT NOT NULL,
  "upstream_id" TEXT NOT NULL,
  "version" TEXT,
  "digest" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "third_party_source_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "third_party_source_items_source_id_kind_upstream_id_key"
ON "third_party_source_items"("source_id", "kind", "upstream_id");
CREATE INDEX "third_party_source_items_source_id_idx" ON "third_party_source_items"("source_id");

-- 5. Wire foreign keys after base tables exist.
ALTER TABLE "grants"
ADD CONSTRAINT "grants_group_id_fkey"
FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "grants"
ADD CONSTRAINT "grants_mcp_server_id_fkey"
FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grants"
ADD CONSTRAINT "grants_skill_bundle_id_fkey"
FOREIGN KEY ("skill_bundle_id") REFERENCES "skill_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_servers"
ADD CONSTRAINT "mcp_servers_source_id_fkey"
FOREIGN KEY ("source_id") REFERENCES "third_party_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mcp_server_grants"
ADD CONSTRAINT "mcp_server_grants_mcp_server_id_fkey"
FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_server_grants"
ADD CONSTRAINT "mcp_server_grants_grant_id_fkey"
FOREIGN KEY ("grant_id") REFERENCES "grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_server_grants"
ADD CONSTRAINT "mcp_server_grants_group_id_fkey"
FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mcp_server_credentials"
ADD CONSTRAINT "mcp_server_credentials_mcp_server_id_fkey"
FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_bundles"
ADD CONSTRAINT "skill_bundles_source_id_fkey"
FOREIGN KEY ("source_id") REFERENCES "third_party_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "skill_entitlements"
ADD CONSTRAINT "skill_entitlements_skill_bundle_id_fkey"
FOREIGN KEY ("skill_bundle_id") REFERENCES "skill_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_entitlements"
ADD CONSTRAINT "skill_entitlements_grant_id_fkey"
FOREIGN KEY ("grant_id") REFERENCES "grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_entitlements"
ADD CONSTRAINT "skill_entitlements_group_id_fkey"
FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "skill_promotions"
ADD CONSTRAINT "skill_promotions_skill_bundle_id_fkey"
FOREIGN KEY ("skill_bundle_id") REFERENCES "skill_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "third_party_source_items"
ADD CONSTRAINT "third_party_source_items_source_id_fkey"
FOREIGN KEY ("source_id") REFERENCES "third_party_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed-group migration note:
-- During rollout, seed baseline group memberships from the existing
-- tenant_dataset_memberships table before operators start authoring grants.
-- Suggested one-time pattern:
--   INSERT INTO "groups" ("id", "name", "scope", "description", "members", "created_at", "updated_at")
--   SELECT
--     CONCAT('seed-', LOWER("scope"), '-', encode(sha256("subject"::bytea), 'hex')),
--     CASE WHEN "scope" = 'Team' THEN CONCAT('team:', "subject") ELSE LOWER("scope") || ':' || "subject" END,
--     CASE WHEN "scope" = 'Org' THEN 'org'::"grant_scope"
--          WHEN "scope" = 'Team' THEN 'department'::"grant_scope"
--          WHEN "scope" = 'Project' THEN 'project'::"grant_scope"
--          ELSE 'personal'::"grant_scope" END,
--     'Seeded from tenant_dataset_memberships during Phase 4 migration',
--     jsonb_agg("tenant" ORDER BY "tenant"),
--     CURRENT_TIMESTAMP,
--     CURRENT_TIMESTAMP
--   FROM "tenant_dataset_memberships"
--   GROUP BY "scope", "subject";
