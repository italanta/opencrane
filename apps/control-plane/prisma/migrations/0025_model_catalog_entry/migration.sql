-- Migration 0025: ModelCatalogEntry (discovery layer)
--
-- Adds the model_catalog_entries table: the "available but not enabled"
-- discovery layer.  Populated by the catalog-reconcile cron (LiteLLM cost
-- map as the billing spine + models.dev for enrichment).  No entries here
-- are callable; enablement stays in model_definitions.

CREATE TABLE "model_catalog_entries" (
    "id"                    TEXT            NOT NULL,
    "litellm_key"           TEXT            NOT NULL,
    "provider"              TEXT            NOT NULL,
    "mode"                  TEXT,
    "input_cost_per_token"  DECIMAL(20,12),
    "output_cost_per_token" DECIMAL(20,12),
    "max_input_tokens"      INTEGER,
    "max_output_tokens"     INTEGER,
    "models_dev_id"         TEXT,
    "modalities_in"         TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    "modalities_out"        TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    "capabilities"          JSONB,
    "cache_read_cost"       DECIMAL(20,12),
    "cache_write_cost"      DECIMAL(20,12),
    "release_date"          TEXT,
    "knowledge_cutoff"      TEXT,
    "open_weights"          BOOLEAN,
    "hosting_regions"       TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
    "pricing_updated_at"    TIMESTAMP(3),
    "first_seen_at"         TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"          TIMESTAMP(3)    NOT NULL,
    "deprecated_at"         TIMESTAMP(3),

    CONSTRAINT "model_catalog_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_catalog_entries_litellm_key_key"
    ON "model_catalog_entries"("litellm_key");

CREATE INDEX "model_catalog_entries_provider_idx"
    ON "model_catalog_entries"("provider");

CREATE INDEX "model_catalog_entries_deprecated_at_idx"
    ON "model_catalog_entries"("deprecated_at");
