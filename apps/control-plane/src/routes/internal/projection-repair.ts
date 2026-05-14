import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL, POLICY_CRD_PLURAL } from "./crd-constants.js";
import type { ProjectionRepairEntry, ProjectionRepairReport } from "./projection-repair.types.js";

/** Minimal Kubernetes list payload shape returned by the client. */
interface KubernetesList<TItem>
{
  /** List body from the generated client. */
  body?: {
    /** Items present in the list response. */
    items?: TItem[];
  };
}

/** Minimal Tenant CRD shape needed for repair. */
interface TenantCrd
{
  /** Standard Kubernetes metadata. */
  metadata?: { name?: string };

  /** Tenant desired state from the CRD. */
  spec?: {
    displayName?: string;
    email?: string;
    team?: string;
  };
}

/** Minimal AccessPolicy CRD shape needed for repair. */
interface AccessPolicyCrd
{
  /** Standard Kubernetes metadata. */
  metadata?: { name?: string };

  /** Policy desired state from the CRD. */
  spec?: {
    description?: string;
    tenantSelector?: unknown;
    domains?: unknown;
    egressRules?: unknown;
    mcpServers?: unknown;
  };
}

/**
 * Repair Tenant projection rows so they match the CRD source of truth.
 *
 * CRDs are treated as authoritative. Missing projection rows are created;
 * rows with field drift are updated. Projection rows that have no matching
 * CRD are skipped — they may belong to tenants being deleted.
 *
 * Passing `dryRun: true` simulates all actions without writing to the database.
 */
export async function _RepairTenantProjection(customApi: k8s.CustomObjectsApi, prisma: PrismaClient, namespace: string,
                                              dryRun: boolean): Promise<ProjectionRepairReport>
{
  // 1. Read CRDs — the authoritative desired-state source.
  const sourceResponse = await customApi.listNamespacedCustomObject({
    group: OPENCRANE_API_GROUP,
    version: OPENCRANE_API_VERSION,
    namespace,
    plural: TENANT_CRD_PLURAL,
  }) as KubernetesList<TenantCrd>;

  const crds = _readItems(sourceResponse);

  // 2. Read projection rows so we can detect missing vs drifted entries.
  const rows = await prisma.tenant.findMany({ orderBy: { name: "asc" } });
  const rowByName = new Map(rows.map((r) => [r.name, r]));

  // 3. Reconcile each CRD into the projection store.
  const entries: ProjectionRepairEntry[] = [];

  for (const crd of crds)
  {
    const name = crd.metadata?.name ?? "";
    if (!name)
    {
      continue;
    }

    const displayName = crd.spec?.displayName ?? "";
    const email = crd.spec?.email ?? "";
    const team = crd.spec?.team ?? null;
    const existing = rowByName.get(name);

    if (!existing)
    {
      // 3a. Projection row is missing — insert from CRD state.
      if (!dryRun)
      {
        await prisma.tenant.create({ data: { name, displayName, email, team: team ?? undefined } });
      }

      entries.push({ name, action: "created", reason: "missing projection row created from CRD", dryRun });
      continue;
    }

    // 3b. Both sides exist — check for field drift and update if needed.
    const drifted = existing.displayName !== displayName
      || existing.email !== email
      || (existing.team ?? null) !== team;

    if (drifted)
    {
      if (!dryRun)
      {
        await prisma.tenant.update({ where: { name }, data: { displayName, email, team: team ?? undefined } });
      }

      entries.push({ name, action: "updated", reason: "field drift corrected from CRD", dryRun });
    }
  }

  // 4. Skip projection rows that have no CRD counterpart.
  const crdNames = new Set(crds.map((c) => c.metadata?.name ?? ""));
  for (const row of rows)
  {
    if (!crdNames.has(row.name))
    {
      entries.push({ name: row.name, action: "skipped", reason: "no CRD source found; may be mid-deletion", dryRun });
    }
  }

  const repairedCount = entries.filter((e) => e.action === "created" || e.action === "updated").length;
  const skippedCount = entries.filter((e) => e.action === "skipped").length;

  return {
    resource: "Tenant",
    mode: dryRun ? "dry-run" : "apply",
    repairedCount,
    skippedCount,
    entries,
  };
}

/**
 * Repair AccessPolicy projection rows so they match the CRD source of truth.
 *
 * Same semantics as {@link _RepairTenantProjection}: CRDs win, dry-run is safe.
 */
export async function _RepairPolicyProjection(customApi: k8s.CustomObjectsApi, prisma: PrismaClient, namespace: string, dryRun: boolean): Promise<ProjectionRepairReport>
{
  // 1. Read AccessPolicy CRDs as the source of truth.
  const sourceResponse = await customApi.listNamespacedCustomObject({
    group: OPENCRANE_API_GROUP,
    version: OPENCRANE_API_VERSION,
    namespace,
    plural: POLICY_CRD_PLURAL,
  }) as KubernetesList<AccessPolicyCrd>;

  const crds = _readItems(sourceResponse);

  // 2. Read current projection rows.
  const rows = await prisma.accessPolicy.findMany({ orderBy: { name: "asc" } });
  const rowByName = new Map(rows.map((r) => [r.name, r]));

  // 3. Reconcile each CRD into the projection store.
  const entries: ProjectionRepairEntry[] = [];

  for (const crd of crds)
  {
    const name = crd.metadata?.name ?? "";
    if (!name)
    {
      continue;
    }

    const description = crd.spec?.description ?? null;
    const tenantSelector = (crd.spec?.tenantSelector as object) ?? null;
    const domains = (crd.spec?.domains as object) ?? null;
    const egressRules = (crd.spec?.egressRules as object) ?? null;
    const mcpServers = (crd.spec?.mcpServers as object) ?? null;
    const existing = rowByName.get(name);

    if (!existing)
    {
      // 3a. Missing projection row — insert from CRD.
      if (!dryRun)
      {
        await prisma.accessPolicy.create({
          data: {
            name,
            description,
            tenantSelector,
            domains,
            egressRules,
            mcpServers,
          },
        });
      }

      entries.push({ name, action: "created", reason: "missing projection row created from CRD", dryRun });
      continue;
    }

    // 3b. Check for field drift on the JSON-comparable fields.
    const drifted = existing.description !== description
      || JSON.stringify(existing.tenantSelector) !== JSON.stringify(tenantSelector)
      || JSON.stringify(existing.domains) !== JSON.stringify(domains)
      || JSON.stringify(existing.egressRules) !== JSON.stringify(egressRules)
      || JSON.stringify(existing.mcpServers) !== JSON.stringify(mcpServers);

    if (drifted)
    {
      if (!dryRun)
      {
        await prisma.accessPolicy.update({
          where: { name },
          data: { description, tenantSelector, domains, egressRules, mcpServers },
        });
      }

      entries.push({ name, action: "updated", reason: "field drift corrected from CRD", dryRun });
    }
  }

  // 4. Skip projection rows that have no CRD counterpart.
  const crdNames = new Set(crds.map((c) => c.metadata?.name ?? ""));
  for (const row of rows)
  {
    if (!crdNames.has(row.name))
    {
      entries.push({ name: row.name, action: "skipped", reason: "no CRD source found; may be mid-deletion", dryRun });
    }
  }

  const repairedCount = entries.filter((e) => e.action === "created" || e.action === "updated").length;
  const skippedCount = entries.filter((e) => e.action === "skipped").length;

  return {
    resource: "AccessPolicy",
    mode: dryRun ? "dry-run" : "apply",
    repairedCount,
    skippedCount,
    entries,
  };
}

/** Extract items from a Kubernetes list response, defaulting to empty. */
function _readItems<T>(response: KubernetesList<T>): T[]
{
  return response.body?.items ?? [];
}
