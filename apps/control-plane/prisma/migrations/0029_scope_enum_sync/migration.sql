-- Migration 0029: sync the GrantScope and DatasetScope levels (S4c)
--
-- The grant/group scope vocabulary (org/department/project/personal) and the Cognee
-- dataset scope vocabulary (org/team/project/personal) diverged on the middle tier
-- (department vs team). S4c derives dataset memberships from the group/grant expansion, so
-- the two vocabularies must align 1:1. Give EACH the level it was missing: grants gain
-- `team`, datasets gain `department`. Additive only — no existing row changes.
--
-- NOTE: the two scopes are stored differently in the DB:
--   * grant scope  → a real Postgres enum type `grant_scope` (ALTER TYPE … ADD VALUE)
--   * dataset scope → a TEXT column on `tenant_dataset_memberships` guarded by a CHECK
--     constraint (migration 0003) — widened here, not an enum.

-- 1. grant_scope enum: add `team`. Idempotent; safe to re-run.
ALTER TYPE "grant_scope" ADD VALUE IF NOT EXISTS 'team';

-- 2. dataset scope CHECK: allow `department` alongside the existing team/project/personal
--    (org still pins to the singleton `default` subject). Re-create the constraint verbatim
--    from migration 0003 with `department` added to the non-org set.
ALTER TABLE "tenant_dataset_memberships"
  DROP CONSTRAINT "tenant_dataset_memberships_scope_subject_check";

ALTER TABLE "tenant_dataset_memberships"
  ADD CONSTRAINT "tenant_dataset_memberships_scope_subject_check"
  CHECK (
    ("scope" IN ('team', 'department', 'project', 'personal') AND LENGTH(BTRIM("subject")) > 0)
    OR ("scope" = 'org' AND "subject" = 'default')
  );
