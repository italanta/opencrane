-- Migration 0012: Session→scope binding for anti-spill awareness retrieval (P4B.7)

CREATE TABLE "session_scopes" (
  "session_key" TEXT NOT NULL,
  "principal"   TEXT NOT NULL,
  "scopes"      JSONB NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "session_scopes_pkey" PRIMARY KEY ("session_key")
);
CREATE INDEX "session_scopes_principal_idx" ON "session_scopes"("principal");
