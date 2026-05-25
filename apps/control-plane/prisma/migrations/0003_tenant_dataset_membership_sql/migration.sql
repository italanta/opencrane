-- CreateTable
CREATE TABLE "tenant_dataset_memberships" (
    "tenant" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_dataset_memberships_pkey" PRIMARY KEY ("tenant", "scope", "subject")
);

-- Enforce supported scope values and ensure org maps to the singleton default subject.
ALTER TABLE "tenant_dataset_memberships"
ADD CONSTRAINT "tenant_dataset_memberships_scope_subject_check"
CHECK (
  ("scope" IN ('team', 'project', 'personal') AND LENGTH(BTRIM("subject")) > 0)
  OR
  ("scope" = 'org' AND "subject" = 'default')
);

-- Speed up per-tenant scope lookups used by API projections.
CREATE INDEX "tenant_dataset_memberships_tenant_scope_idx"
ON "tenant_dataset_memberships"("tenant", "scope");

-- AddForeignKey
ALTER TABLE "tenant_dataset_memberships"
ADD CONSTRAINT "tenant_dataset_memberships_tenant_fkey"
FOREIGN KEY ("tenant") REFERENCES "tenants"("name")
ON DELETE CASCADE
ON UPDATE CASCADE;
