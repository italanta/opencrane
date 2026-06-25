-- Migration 0028: record who shared a grant (S4 inter-user sharing)
--
-- The `oc share` API lets a user grant another user/group an entitlement they themselves
-- hold (least-privilege; no escalation). Record the sharer's IdP subject so they can list
-- and revoke ONLY the grants they created — without gaining any authority over grants made
-- by the admin entitlement paths (those rows keep `shared_by` NULL).
ALTER TABLE "grants"
  ADD COLUMN "shared_by" TEXT;

-- List-/revoke-mine queries filter by the sharer, so index it.
CREATE INDEX "grants_shared_by_idx"
  ON "grants" ("shared_by");
