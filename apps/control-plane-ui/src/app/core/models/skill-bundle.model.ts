import { GrantScope, type Grant } from "./grant.model";

/** Publishing state shown for a skill bundle. */
export enum SkillBundleStatus
{
  Published = "published",
  Review = "review",
  Draft = "draft",
}

/** Immutable skill bundle metadata displayed in the catalog UI. */
export interface SkillBundle
{
  /** Stable bundle identifier. */
  id: string;
  /** Display name shown in the catalog. */
  name: string;
  /** Short summary of the skill bundle. */
  description: string;
  /** Semantic version label. */
  version: string;
  /** OCI digest pin backing the bundle. */
  digest: string;
  /** Highest scope where the bundle is promoted. */
  scope: GrantScope;
  /** Current publishing state. */
  status: SkillBundleStatus;
  /** Search and categorization labels. */
  tags: string[];
  /** Compiled grants for the bundle. */
  grants: Grant[];
  /** Optional upstream source label. */
  sourceName?: string;
  /** Last publish timestamp. */
  publishedAt?: string;
}
