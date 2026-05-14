import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL, POLICY_CRD_PLURAL } from "./crd-constants.js";

/** Single detect-only mismatch discovered between CRDs and PostgreSQL projections. */
export interface ProjectionDriftMismatch
{
  /** Resource name shared by the CRD and projection row. */
  name: string;

  /** Coarse mismatch class used by dashboards and operators. */
  issue: "missing-source" | "missing-projection" | "field-mismatch";

  /** Specific fields that differed when both sides existed. */
  fields?: string[];
}

/** Summary payload returned by the projection drift report endpoints. */
export interface ProjectionDriftReport
{
  /** Entity family being compared. */
  resource: "Tenant" | "AccessPolicy";

  /** Current hardening mode for this report. */
  mode: "detect-only";

  /** Fields compared for this entity family. */
  comparedFields: string[];

  /** Aggregate counts that make drift volume easy to monitor. */
  summary: {
    /** Number of CRDs treated as the source of truth. */
    sourceCount: number;

    /** Number of PostgreSQL projection rows compared against CRDs. */
    projectionCount: number;

    /** Number of drift findings in this report. */
    driftCount: number;
  };

  /** Per-resource findings for operators to inspect manually. */
  mismatches: ProjectionDriftMismatch[];
}

/** Minimal named snapshot used by the generic drift comparison helper. */
interface NamedSnapshot
{
  /** Shared logical resource name. */
  name: string;

  /** Comparable field bag for the resource. */
  fields: Record<string, unknown>;
}

/** Minimal Kubernetes list payload shape returned by the client. */
interface KubernetesList<TItem>
{
  /** List body returned by the generated client. */
  body?: {
    /** Items present in the list response. */
    items?: TItem[];
  };
}

/** Minimal Tenant CRD shape needed for drift comparison. */
interface TenantCustomResource
{
  /** Standard Kubernetes metadata. */
  metadata?: {
    /** Logical resource name. */
    name?: string;
  };

  /** Tenant desired state authored in the CRD. */
  spec?: {
    /** Human-readable tenant name. */
    displayName?: string;

    /** Contact email for the tenant. */
    email?: string;

    /** Optional team ownership label. */
    team?: string;
  };
}

/** Minimal AccessPolicy CRD shape needed for drift comparison. */
interface AccessPolicyCustomResource
{
  /** Standard Kubernetes metadata. */
  metadata?: {
    /** Logical resource name. */
    name?: string;
  };

  /** Policy desired state authored in the CRD. */
  spec?: {
    /** Optional description shown in the UI. */
    description?: string;

    /** Optional tenant selection criteria. */
    tenantSelector?: unknown;

    /** Optional domain allow or deny configuration. */
    domains?: unknown;

    /** Optional low-level egress rules. */
    egressRules?: unknown;

    /** Optional MCP server allow or deny configuration. */
    mcpServers?: unknown;
  };
}

/**
 * Compare Tenant CRDs against their PostgreSQL projection rows.
 *
 * This intentionally compares only the fields that are already dual-written
 * by the request path today. Runtime-driven status fields such as ingress host
 * are excluded until a dedicated status projector exists.
 */
export async function _DetectTenantProjectionDrift(
  customApi: k8s.CustomObjectsApi,
  prisma: PrismaClient,
  namespace: string,
): Promise<ProjectionDriftReport>
{
  const comparedFields = ["displayName", "email", "team"];

  // 1. Read the CRDs that remain the desired-state source of truth.
  const sourceResponse = await customApi.listNamespacedCustomObject({
    group: OPENCRANE_API_GROUP,
    version: OPENCRANE_API_VERSION,
    namespace,
    plural: TENANT_CRD_PLURAL,
  }) as KubernetesList<TenantCustomResource>;

  // 2. Read the current PostgreSQL projection rows exposed by the control-plane.
  const projections = await prisma.tenant.findMany({
    orderBy: { name: "asc" },
  });

  // 3. Build a detect-only drift report without mutating either side.
  return _BuildProjectionDriftReport(
    "Tenant",
    comparedFields,
    _ReadKubernetesListItems(sourceResponse).map(function _mapTenantSource(item)
    {
      return {
        name: item.metadata?.name ?? "",
        fields: {
          displayName: item.spec?.displayName,
          email: item.spec?.email,
          team: item.spec?.team,
        },
      };
    }),
    projections.map(function _mapTenantProjection(item)
    {
      return {
        name: item.name,
        fields: {
          displayName: item.displayName,
          email: item.email,
          team: item.team,
        },
      };
    }),
  );
}

/**
 * Compare AccessPolicy CRDs against their PostgreSQL projection rows.
 */
export async function _DetectPolicyProjectionDrift(
  customApi: k8s.CustomObjectsApi,
  prisma: PrismaClient,
  namespace: string,
): Promise<ProjectionDriftReport>
{
  const comparedFields = ["description", "tenantSelector", "domains", "egressRules", "mcpServers"];

  // 1. Read the CRDs that the policy operator reconciles from.
  const sourceResponse = await customApi.listNamespacedCustomObject({
    group: OPENCRANE_API_GROUP,
    version: OPENCRANE_API_VERSION,
    namespace,
    plural: POLICY_CRD_PLURAL,
  }) as KubernetesList<AccessPolicyCustomResource>;

  // 2. Read the query-store projection rows used by the API and UI.
  const projections = await prisma.accessPolicy.findMany({
    orderBy: { name: "asc" },
  });

  // 3. Report drift without attempting automatic repair in this phase.
  return _BuildProjectionDriftReport(
    "AccessPolicy",
    comparedFields,
    _ReadKubernetesListItems(sourceResponse).map(function _mapPolicySource(item)
    {
      return {
        name: item.metadata?.name ?? "",
        fields: {
          description: item.spec?.description,
          tenantSelector: item.spec?.tenantSelector,
          domains: item.spec?.domains,
          egressRules: item.spec?.egressRules,
          mcpServers: item.spec?.mcpServers,
        },
      };
    }),
    projections.map(function _mapPolicyProjection(item)
    {
      return {
        name: item.name,
        fields: {
          description: item.description,
          tenantSelector: item.tenantSelector,
          domains: item.domains,
          egressRules: item.egressRules,
          mcpServers: item.mcpServers,
        },
      };
    }),
  );
}

/**
 * Build a detect-only drift report for a named resource family.
 */
function _BuildProjectionDriftReport(
  resource: "Tenant" | "AccessPolicy",
  comparedFields: string[],
  sourceItems: NamedSnapshot[],
  projectionItems: NamedSnapshot[],
): ProjectionDriftReport
{
  const sourceByName = _BuildSnapshotMap(sourceItems);
  const projectionByName = _BuildSnapshotMap(projectionItems);
  const mismatches: ProjectionDriftMismatch[] = [];
  const allNames = Array.from(new Set([...sourceByName.keys(), ...projectionByName.keys()])).sort();

  for (const name of allNames)
  {
    const source = sourceByName.get(name);
    const projection = projectionByName.get(name);

    if (!source)
    {
      mismatches.push({ name, issue: "missing-source" });
      continue;
    }

    if (!projection)
    {
      mismatches.push({ name, issue: "missing-projection" });
      continue;
    }

    const driftedFields = comparedFields.filter(function _fieldDrifted(field)
    {
      return !_ComparableValuesEqual(source.fields[field], projection.fields[field]);
    });

    if (driftedFields.length > 0)
    {
      mismatches.push({ name, issue: "field-mismatch", fields: driftedFields });
    }
  }

  return {
    resource,
    mode: "detect-only",
    comparedFields,
    summary: {
      sourceCount: sourceItems.length,
      projectionCount: projectionItems.length,
      driftCount: mismatches.length,
    },
    mismatches,
  };
}

/**
 * Convert a list of named snapshots into a map keyed by resource name.
 */
function _BuildSnapshotMap(items: NamedSnapshot[]): Map<string, NamedSnapshot>
{
  return new Map(
    items
      .filter(function _hasName(item)
      {
        return item.name.length > 0;
      })
      .map(function _toEntry(item)
      {
        return [item.name, item] as const;
      }),
  );
}

/**
 * Extract list items from the Kubernetes client response payload.
 */
function _ReadKubernetesListItems<TItem>(response: KubernetesList<TItem>): TItem[]
{
  return response.body?.items ?? [];
}

/**
 * Compare potentially nested JSON-like values with stable object key ordering.
 */
function _ComparableValuesEqual(left: unknown, right: unknown): boolean
{
  return JSON.stringify(_NormalizeComparableValue(left)) === JSON.stringify(_NormalizeComparableValue(right));
}

/**
 * Normalise values so undefined and object key-order noise do not create false drift.
 */
function _NormalizeComparableValue(value: unknown): unknown
{
  if (value === undefined)
  {
    return null;
  }

  if (value === null)
  {
    return null;
  }

  if (Array.isArray(value))
  {
    return value.map(_NormalizeComparableValue);
  }

  if (typeof value === "object")
  {
    return Object.fromEntries(
      Object.entries(value)
        .sort(function _sortEntries([leftKey], [rightKey])
        {
          return leftKey.localeCompare(rightKey);
        })
        .map(function _normaliseEntry([key, childValue])
        {
          return [key, _NormalizeComparableValue(childValue)];
        }),
    );
  }

  return value;
}
