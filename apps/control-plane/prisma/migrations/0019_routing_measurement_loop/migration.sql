-- Migration 0019: Shadow measurement + improvement-loop machinery (Track AIR — AIR.6/7).
--
-- Per-skill golden eval cases (the quality-bar substrate), shadow-mode savings measurements, and
-- human-gated routing-change proposals (never auto-applied). Additive + opt-in.

CREATE TYPE "RoutingProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'applied');

CREATE TABLE "routing_eval_cases" (
  "id"          TEXT NOT NULL,
  "skill_name"  TEXT NOT NULL,
  "skill_scope" TEXT NOT NULL,
  "skill_team"  TEXT NOT NULL DEFAULT '',
  "input"       JSONB NOT NULL,
  "expected"    JSONB,
  "quality_bar" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "routing_eval_cases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "routing_eval_cases_skill_idx" ON "routing_eval_cases" ("skill_name", "skill_scope", "skill_team");

CREATE TABLE "routing_measurements" (
  "id"                    TEXT NOT NULL,
  "skill_name"            TEXT NOT NULL,
  "skill_scope"           TEXT NOT NULL,
  "skill_team"            TEXT NOT NULL DEFAULT '',
  "candidate_model"       TEXT,
  "sampled_calls"         INTEGER NOT NULL,
  "at_bar_cheap_fraction" DOUBLE PRECISION NOT NULL,
  "projected_savings_pct" DOUBLE PRECISION NOT NULL,
  "ci_low_pct"            DOUBLE PRECISION NOT NULL,
  "ci_high_pct"           DOUBLE PRECISION NOT NULL,
  "overhead_pct"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "run_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "routing_measurements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "routing_measurements_skill_idx" ON "routing_measurements" ("skill_name", "skill_scope", "skill_team");

CREATE TABLE "routing_proposals" (
  "id"                    TEXT NOT NULL,
  "skill_name"            TEXT NOT NULL,
  "skill_scope"           TEXT NOT NULL,
  "skill_team"            TEXT NOT NULL DEFAULT '',
  "from_model"            TEXT,
  "proposed_model"        TEXT NOT NULL,
  "projected_savings_pct" DOUBLE PRECISION NOT NULL,
  "ci_low_pct"            DOUBLE PRECISION NOT NULL,
  "ci_high_pct"           DOUBLE PRECISION NOT NULL,
  "measurement_id"        TEXT,
  "status"                "RoutingProposalStatus" NOT NULL DEFAULT 'pending',
  "decided_by"            TEXT,
  "decided_at"            TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "routing_proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "routing_proposals_status_idx" ON "routing_proposals" ("status");
