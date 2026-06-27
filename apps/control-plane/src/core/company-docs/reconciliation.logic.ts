import type { DocMergeProposal, PrismaClient } from "@prisma/client";
import { DocProposalStatus } from "@prisma/client";

import { _AssertNoL0Directives } from "../../core/personalisation/l0-guard.js";
import type { DocMergeReconciler } from "../../core/personalisation/reconciler.types.js";
import type { DecideProposalResult, DocProposalResponse } from "../../routes/company-docs.types.js";

/** Distinct outcomes of a reconcile attempt. */
export type ReconcileOutcome =
  | { kind: "no-company-version" }
  | { kind: "no-tenant" }
  | { kind: "up-to-date"; version: number }
  | { kind: "proposed"; proposal: DocProposalResponse };

/**
 * Generate a company→tenant reconciliation proposal (P4C.4).
 *
 * Runs the 3-way merge (base = the tenant's last-reconciled company version,
 * ours = the current company version, theirs = the tenant's current doc),
 * guards the result against L0 directives (the agent can never edit L0), and
 * upserts a pending proposal keyed by (tenant, docName, targetVersion) so the
 * run is idempotent/resumable. No tenant doc is changed until approval (P4C.5).
 *
 * @param prisma      - Prisma client.
 * @param reconciler  - The merge engine (deterministic default or LiteLLM seam).
 * @param name        - Company doc name.
 * @param tenant      - Tenant to reconcile.
 * @returns A tagged outcome: missing prerequisites, already up-to-date, or a proposal.
 * @throws When the merged result carries forbidden L0 directives (sandbox breach).
 */
export async function _ReconcileTenantDoc(prisma: PrismaClient, reconciler: DocMergeReconciler, name: string, tenant: string): Promise<ReconcileOutcome>
{
  // 1. Resolve the current company version (the merge target); nothing to do
  //    until at least one company version is published.
  const doc = await prisma.companyDoc.findUnique({ where: { name }, select: { id: true, currentVersion: true } });
  if (!doc || doc.currentVersion === 0)
  {
    return { kind: "no-company-version" };
  }

  // 2. The tenant must exist before we record a proposal against it.
  const tenantRow = await prisma.tenant.findUnique({ where: { name: tenant }, select: { name: true } });
  if (!tenantRow)
  {
    return { kind: "no-tenant" };
  }

  // 3. Load the tenant's current doc + reconciliation cursor; absent means a
  //    fresh tenant with no local edits (base/theirs empty, cursor 0).
  const workspace = await prisma.tenantWorkspaceDoc.findUnique({
    where: { tenant_docName: { tenant, docName: name } },
    select: { content: true, lastReconciledVersion: true },
  });
  const lastReconciledVersion = workspace?.lastReconciledVersion ?? 0;
  const theirs = workspace?.content ?? "";

  // 4. Idempotent fast-exit — the tenant is already on the current version.
  if (lastReconciledVersion === doc.currentVersion)
  {
    return { kind: "up-to-date", version: doc.currentVersion };
  }

  // 5. Resolve the base ("ours-last-accepted") and ours (target) version content.
  const base = lastReconciledVersion > 0
    ? (await prisma.companyDocVersion.findUnique({ where: { companyDocId_version: { companyDocId: doc.id, version: lastReconciledVersion } }, select: { content: true } }))?.content ?? ""
    : "";
  const ours = (await prisma.companyDocVersion.findUnique({ where: { companyDocId_version: { companyDocId: doc.id, version: doc.currentVersion } }, select: { content: true } }))?.content ?? "";

  // 6. Run the merge and enforce the L0 sandbox on its output before persisting.
  const merge = await reconciler.reconcile({ docName: name, base, ours, theirs });
  _AssertNoL0Directives(merge.merged);

  // 7. Upsert the pending proposal (idempotent on the target version); a re-run
  //    refreshes the proposed content and resets any prior decision.
  const proposal = await prisma.docMergeProposal.upsert({
    where: { tenant_docName_targetVersion: { tenant, docName: name, targetVersion: doc.currentVersion } },
    create: {
      tenant,
      docName: name,
      baseVersion: lastReconciledVersion,
      targetVersion: doc.currentVersion,
      proposedContent: merge.merged,
      diff: merge.diff,
    },
    update: {
      baseVersion: lastReconciledVersion,
      proposedContent: merge.merged,
      diff: merge.diff,
      status: DocProposalStatus.Pending,
      decidedAt: null,
      decidedBy: null,
    },
  });

  return { kind: "proposed", proposal: _ToProposalResponse(proposal) };
}

/**
 * List reconciliation proposals for a company doc, newest first (P4C.4/P4C.5).
 *
 * @param prisma  - Prisma client.
 * @param name    - Company doc name.
 * @param filters - Optional tenant and status filters.
 */
export async function _ListProposals(prisma: PrismaClient, name: string, filters: { tenant?: string; status?: DocProposalStatus }): Promise<DocProposalResponse[]>
{
  const proposals = await prisma.docMergeProposal.findMany({
    where: { docName: name, ...(filters.tenant ? { tenant: filters.tenant } : {}), ...(filters.status ? { status: filters.status } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return proposals.map(_ToProposalResponse);
}

/**
 * Approve or reject a reconciliation proposal (P4C.5).
 *
 * On **approve**, the proposed content becomes the tenant's effective workspace
 * doc and the reconciliation cursor advances to the target version — both in one
 * transaction with the status flip — so the next contract re-pull delivers it
 * into the pod with no restart. On **reject**, only the proposal status changes;
 * the tenant doc is left untouched.
 *
 * @param prisma     - Prisma client.
 * @param name       - Company doc name (must match the proposal).
 * @param proposalId - The proposal to decide.
 * @param decision   - `"approve"` or `"reject"`.
 * @param decidedBy  - Identity making the decision (for audit).
 * @returns The decision result, or null when the proposal is missing/mismatched.
 * @throws When the proposal is not pending (already decided).
 */
export async function _DecideProposal(prisma: PrismaClient, name: string, proposalId: string, decision: "approve" | "reject", decidedBy: string): Promise<DecideProposalResult | null>
{
  // 1. Load and validate the proposal — it must exist and belong to this doc.
  const proposal = await prisma.docMergeProposal.findUnique({ where: { id: proposalId } });
  if (!proposal || proposal.docName !== name)
  {
    return null;
  }

  // 2. Only a pending proposal can be decided — guard against double-apply.
  if (proposal.status !== DocProposalStatus.Pending)
  {
    throw new Error(`proposal ${proposalId} is already ${proposal.status.toLowerCase()}`);
  }

  // 3. Reject — flip status only; the tenant's doc and cursor stay as they were.
  if (decision === "reject")
  {
    await prisma.docMergeProposal.update({
      where: { id: proposalId },
      data: { status: DocProposalStatus.Rejected, decidedAt: new Date(), decidedBy },
    });
    return { id: proposalId, status: "rejected", deliveredVersion: null };
  }

  // 4. Approve — deliver the merged content as the tenant's effective doc and
  //    advance the cursor atomically with the status flip.
  await prisma.$transaction(async function _approve(tx): Promise<void>
  {
    await tx.tenantWorkspaceDoc.upsert({
      where: { tenant_docName: { tenant: proposal.tenant, docName: proposal.docName } },
      create: {
        tenant: proposal.tenant,
        docName: proposal.docName,
        content: proposal.proposedContent,
        lastReconciledVersion: proposal.targetVersion,
      },
      update: {
        content: proposal.proposedContent,
        lastReconciledVersion: proposal.targetVersion,
      },
    });

    await tx.docMergeProposal.update({
      where: { id: proposalId },
      data: { status: DocProposalStatus.Approved, decidedAt: new Date(), decidedBy },
    });
  });

  return { id: proposalId, status: "approved", deliveredVersion: proposal.targetVersion };
}

/**
 * Map a Prisma proposal row to the API response shape.
 * @param row - The proposal row.
 */
function _ToProposalResponse(row: DocMergeProposal): DocProposalResponse
{
  return {
    id: row.id,
    tenant: row.tenant,
    docName: row.docName,
    baseVersion: row.baseVersion,
    targetVersion: row.targetVersion,
    proposedContent: row.proposedContent,
    diff: row.diff,
    status: row.status.toLowerCase() as "pending" | "approved" | "rejected",
    createdAt: row.createdAt.toISOString(),
  };
}
