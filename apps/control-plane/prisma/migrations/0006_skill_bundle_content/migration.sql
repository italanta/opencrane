-- Add content storage to skill_bundles so the skill-registry service
-- can serve skill SKILL.md content directly from the database.

ALTER TABLE "skill_bundles" ADD COLUMN "content" TEXT;
ALTER TABLE "skill_bundles" ADD COLUMN "content_type" TEXT NOT NULL DEFAULT 'text/markdown';

-- Index digest for O(1) skill-registry delivery lookups by content hash.
CREATE INDEX "skill_bundles_digest_idx" ON "skill_bundles"("digest");
