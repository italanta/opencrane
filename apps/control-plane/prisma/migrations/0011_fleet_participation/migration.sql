-- Migration 0011: Fleet participation protocol + monitoring (P4B.5)

CREATE TYPE "ParticipationEventKind" AS ENUM ('agent_card', 'skill_execution', 'heartbeat');

CREATE TABLE "participation_events" (
  "id"              TEXT NOT NULL,
  "tenant"          TEXT NOT NULL,
  "kind"            "ParticipationEventKind" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "outcome"         TEXT,
  "payload"         JSONB,
  "occurred_at"     TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "participation_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "participation_events_tenant_idempotency_key_key" ON "participation_events"("tenant", "idempotency_key");
CREATE INDEX "participation_events_tenant_idx" ON "participation_events"("tenant");
ALTER TABLE "participation_events"
  ADD CONSTRAINT "participation_events_tenant_fkey"
  FOREIGN KEY ("tenant") REFERENCES "tenants"("name") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tenant_participation" (
  "tenant"                   TEXT NOT NULL,
  "last_seen_at"             TIMESTAMP(3) NOT NULL,
  "running_contract_version" TEXT,
  "agent_card"               JSONB,
  "skill_execution_count"    INTEGER NOT NULL DEFAULT 0,
  "policy_violation_count"   INTEGER NOT NULL DEFAULT 0,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_participation_pkey" PRIMARY KEY ("tenant")
);
ALTER TABLE "tenant_participation"
  ADD CONSTRAINT "tenant_participation_tenant_fkey"
  FOREIGN KEY ("tenant") REFERENCES "tenants"("name") ON DELETE CASCADE ON UPDATE CASCADE;
