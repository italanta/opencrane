import * as k8s from "@kubernetes/client-node";
import { Prisma, type PrismaClient } from "@prisma/client";

import { OPENCRANE_API_GROUP, OPENCRANE_API_VERSION, TENANT_CRD_PLURAL } from "../../shared/crd-constants.js";
import { _IsK8sConflict, _IsK8sNotFound } from "../../shared/k8s-errors.js";

/** Suffix appended to an org name to form its first workspace Tenant's name. */
export const _DEFAULT_TENANT_SUFFIX = "-default";

/** Outcome of an {@link _EnsureOwnerDefaultTenant} call. */
export interface EnsureDefaultTenantResult
{
  /** The `<org>-default` tenant name that was ensured. */
  tenantName: string;
  /** Whether a new DB projection row was created on this call (false = already present). */
  created: boolean;
  /** When nothing was created and the row was not already present, why it was skipped. */
  skippedReason?: string;
}

/**
 * Ensure an org's first workspace Tenant (`<org>-default`, attributed to the owner)
 * exists as a control-plane dual-write: the Tenant CRD AND its DB projection row.
 *
 * This is the single authority for default-tenant creation. The org create handler calls
 * it so a freshly-provisioned customer has a workspace row immediately (the TenantOperator
 * reconciles it to Running once the org's namespace is bound), and the refresh endpoint
 * calls it to self-heal an org that reached ready without a tenant row.
 *
 * Idempotent and recovery-safe:
 *  - returns early when the DB row already exists (the steady-state path);
 *  - tolerates a pre-existing CRD (AlreadyExists) and still writes the missing DB row,
 *    recovering an org whose CRD was seeded out-of-band without its projection;
 *  - tolerates a P2002 row race.
 *
 * The owner email is taken from `ownerEmail` when provided, else recovered from an existing
 * CRD's `spec.email`. Absent both (the dev-auth path carries only a subject), the seed is
 * skipped with a reason rather than creating an email-less Tenant.
 *
 * @returns Whether a DB row was created, and a skip reason when it was not.
 */
export async function _EnsureOwnerDefaultTenant(opts: {
  customApi: k8s.CustomObjectsApi | null;
  prisma: PrismaClient;
  namespace: string;
  orgName: string;
  orgDisplayName: string;
  ownerEmail?: string | undefined;
}): Promise<EnsureDefaultTenantResult>
{
  const { customApi, prisma, namespace, orgName, orgDisplayName, ownerEmail } = opts;
  const tenantName = `${orgName}${_DEFAULT_TENANT_SUFFIX}`;

  // 1. Already projected → nothing to do (idempotent steady state). The unique key is the
  //    tenant name, so this also collapses a concurrent caller down to a single create.
  const existingRow = await prisma.tenant.findUnique({ where: { name: tenantName } });
  if (existingRow)
  {
    return { tenantName, created: false };
  }

  // 2. Resolve the owner email: the caller's value wins; otherwise recover it from an
  //    already-seeded CRD (the path we are repairing). The CRD read also tells us whether
  //    to skip the create-CRD step below.
  let email = ownerEmail?.trim() ?? "";
  let crdExists = false;
  if (customApi)
  {
    try
    {
      const cr = await customApi.getNamespacedCustomObject({
        group: OPENCRANE_API_GROUP, version: OPENCRANE_API_VERSION, namespace, plural: TENANT_CRD_PLURAL, name: tenantName,
      }) as { spec?: { email?: string } };
      crdExists = true;
      if (!email) email = cr.spec?.email?.trim() ?? "";
    }
    catch (err)
    {
      if (!_IsK8sNotFound(err)) throw err;
    }
  }

  if (!email)
  {
    return { tenantName, created: false, skippedReason: "no owner email available (caller session and CRD both absent)" };
  }

  // 3. Dual-write. Create the CRD first (skip when no cluster is wired or it already
  //    exists; tolerate a create-time AlreadyExists race), then the DB projection row —
  //    the write the operator-only path was missing.
  const displayName = `${orgDisplayName} workspace`;
  if (customApi && !crdExists)
  {
    try
    {
      await customApi.createNamespacedCustomObject({
        group: OPENCRANE_API_GROUP, version: OPENCRANE_API_VERSION, namespace, plural: TENANT_CRD_PLURAL,
        body: {
          apiVersion: `${OPENCRANE_API_GROUP}/${OPENCRANE_API_VERSION}`,
          kind: "Tenant",
          metadata: { name: tenantName, namespace },
          spec: { displayName, email, clusterTenantRef: orgName },
        },
      });
    }
    catch (err)
    {
      if (!_IsK8sConflict(err)) throw err;
    }
  }

  try
  {
    await prisma.tenant.create({
      data: { name: tenantName, displayName, email, clusterTenantRef: orgName },
    });
  }
  catch (err)
  {
    // Lost a create race against a concurrent caller — the row now exists, which is the
    // desired end state; treat as already-present rather than an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
    {
      return { tenantName, created: false };
    }
    throw err;
  }

  // Best-effort audit; the FK target (the tenant row) now exists. A failed audit write
  // must never undo or fail the seed itself.
  await prisma.auditEntry.create({
    data: { tenant: tenantName, action: "Created", resource: `Tenant/${tenantName}`, message: `Default workspace tenant ${tenantName} created for org ${orgName}` },
  }).catch(() => { /* audit is non-critical */ });

  return { tenantName, created: true };
}
