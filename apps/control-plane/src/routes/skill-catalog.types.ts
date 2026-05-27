/** Supported organizational scopes for skill bundles. */
export type SkillCatalogRouteScope = "org" | "department" | "project" | "personal";

/** Supported access outcomes for skill entitlements. */
export type SkillCatalogRouteAccess = "allow" | "deny";

/** Supported subject types for skill entitlements. */
export type SkillCatalogRouteSubjectType = "group" | "tenant" | "user";

/** Supported publishing states for skill bundles. */
export type SkillCatalogRouteStatus = "published" | "review" | "draft";

/** Supported approval states for skill promotion records. */
export type SkillPromotionRouteStatus = "proposed" | "approved" | "rejected";

/** Request body used to create or update a skill entitlement. */
export interface SkillEntitlementInput
{
  /** Organizational scope carried by the grant. */
  scope: SkillCatalogRouteScope;
  /** Subject family receiving the grant. */
  subjectType: SkillCatalogRouteSubjectType;
  /** Subject identifier used by the compiler. */
  subjectId?: string;
  /** Human-friendly subject label accepted for group lookups. */
  subjectName: string;
  /** Allow or deny outcome. */
  access: SkillCatalogRouteAccess;
  /** Higher values override lower-priority grants. */
  priority?: number;
  /** Optional operator note. */
  note?: string;
}

/** Request body used to create or update a skill promotion record. */
export interface SkillPromotionInput
{
  /** Scope being promoted from. */
  fromScope: SkillCatalogRouteScope;
  /** Scope being promoted to. */
  toScope: SkillCatalogRouteScope;
  /** Operator or service account authoring the promotion. */
  promotedBy: string;
  /** Approval state tracked for the promotion. */
  status?: SkillPromotionRouteStatus;
  /** Optional operator note. */
  notes?: string;
}

/** Request body used to create or update a skill bundle. */
export interface SkillBundleWriteRequest
{
  /** Display name shown in the catalog. */
  name: string;
  /** Short summary of the bundle. */
  description?: string;
  /** Semantic version label. */
  version: string;
  /** OCI digest pin backing the bundle. */
  digest: string;
  /** Highest scope where the bundle is promoted. */
  scope: SkillCatalogRouteScope;
  /** Current publishing state. */
  status?: SkillCatalogRouteStatus;
  /** Search and categorization labels. */
  tags?: string[];
  /** Optional upstream source identifier. */
  sourceId?: string;
  /** Optional publish timestamp. */
  publishedAt?: string;
  /** Compiled grants for the bundle. */
  grants?: SkillEntitlementInput[];
  /** Promotion history records. */
  promotions?: SkillPromotionInput[];
}
