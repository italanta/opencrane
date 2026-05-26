-- Add Phase 4 org index schema v2 metadata fields to existing documents.
ALTER TABLE "org_documents"
ADD COLUMN "department_scope" TEXT,
ADD COLUMN "project_scope" TEXT,
ADD COLUMN "confidentiality" TEXT,
ADD COLUMN "jurisdiction" TEXT,
ADD COLUMN "retention_class" TEXT,
ADD COLUMN "acl_origin" TEXT,
ADD COLUMN "source_updated_at" TIMESTAMP(3),
ADD COLUMN "freshness_recorded_at" TIMESTAMP(3),
ADD COLUMN "ingest_cursor" TEXT;

-- Backfill required lineage and freshness fields for pre-Phase-4 rows before
-- tightening the contract to non-null on the read path.
UPDATE "org_documents"
SET
  "acl_origin" = COALESCE("acl_origin", 'legacy:backfill'),
  "source_updated_at" = COALESCE("source_updated_at", "ingested_at"),
  "freshness_recorded_at" = COALESCE("freshness_recorded_at", "ingested_at"),
  "ingest_cursor" = COALESCE("ingest_cursor", "source_id");

ALTER TABLE "org_documents"
ALTER COLUMN "acl_origin" SET NOT NULL,
ALTER COLUMN "source_updated_at" SET NOT NULL,
ALTER COLUMN "freshness_recorded_at" SET NOT NULL,
ALTER COLUMN "ingest_cursor" SET NOT NULL;

-- Speed up future scope-aware filters introduced by organizational awareness features.
CREATE INDEX "org_documents_department_scope_idx" ON "org_documents"("department_scope");
CREATE INDEX "org_documents_project_scope_idx" ON "org_documents"("project_scope");
