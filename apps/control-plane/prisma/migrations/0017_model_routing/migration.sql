-- Migration 0017: Model routing — provider credentials + model definitions (Track AIR).
--
-- BYOM/BYOK model registry. Provider keys are owned at Global (control-plane) or ClusterTenant
-- scope — never per openclaw tenant — and OpenCrane stores only a reference to the
-- External-Secrets-synced k8s Secret (`secret_ref`), never the raw key. Additive + opt-in.

CREATE TYPE "ModelRoutingScope" AS ENUM ('global', 'clusterTenant');

CREATE TABLE "provider_credentials" (
  "id"                      TEXT NOT NULL,
  "scope"                   "ModelRoutingScope" NOT NULL DEFAULT 'global',
  "cluster_tenant"          TEXT,
  "provider"                TEXT NOT NULL,
  "secret_ref"              TEXT NOT NULL,
  "litellm_credential_name" TEXT,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "model_definitions" (
  "id"                     TEXT NOT NULL,
  "scope"                  "ModelRoutingScope" NOT NULL DEFAULT 'global',
  "cluster_tenant"         TEXT,
  "public_model_name"      TEXT NOT NULL,
  "litellm_model_id"       TEXT NOT NULL,
  "upstream_model"         TEXT NOT NULL,
  "api_base"               TEXT,
  "is_default"             BOOLEAN NOT NULL DEFAULT false,
  "provider_credential_id" TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "model_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_credentials_scope_cluster_tenant_provider_key" ON "provider_credentials" ("scope", "cluster_tenant", "provider");
CREATE INDEX "provider_credentials_cluster_tenant_idx" ON "provider_credentials" ("cluster_tenant");

CREATE UNIQUE INDEX "model_definitions_litellm_model_id_key" ON "model_definitions" ("litellm_model_id");
CREATE UNIQUE INDEX "model_definitions_scope_cluster_tenant_public_model_name_key" ON "model_definitions" ("scope", "cluster_tenant", "public_model_name");
CREATE INDEX "model_definitions_cluster_tenant_idx" ON "model_definitions" ("cluster_tenant");

ALTER TABLE "model_definitions"
  ADD CONSTRAINT "model_definitions_provider_credential_id_fkey"
  FOREIGN KEY ("provider_credential_id") REFERENCES "provider_credentials" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
