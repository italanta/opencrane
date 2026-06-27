import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _DecideProposal, _ReconcileTenantDoc } from "../../core/company-docs/reconciliation.logic.js";
import type { DocMergeReconciler } from "../../core/personalisation/reconciler.types.js";

/** A reconciler stub returning a fixed merge. */
const _STUB_RECONCILER: DocMergeReconciler = {
	async reconcile() { return { merged: "merged content", diff: "+ merged content" }; },
};

describe("_ReconcileTenantDoc (P4C.4)", function _suite()
{
	it("returns up-to-date when the tenant is already on the current version", async function _utd()
	{
		const prisma = {
			companyDoc: { findUnique: vi.fn().mockResolvedValue({ id: "d1", currentVersion: 2 }) },
			tenant: { findUnique: vi.fn().mockResolvedValue({ name: "t1" }) },
			tenantWorkspaceDoc: { findUnique: vi.fn().mockResolvedValue({ content: "x", lastReconciledVersion: 2 }) },
		} as unknown as PrismaClient;

		const out = await _ReconcileTenantDoc(prisma, _STUB_RECONCILER, "SOUL", "t1");
		expect(out.kind).toBe("up-to-date");
	});

	it("upserts a pending proposal when the tenant is behind", async function _proposed()
	{
		const upsert = vi.fn().mockResolvedValue({
			id: "p1", tenant: "t1", docName: "SOUL", baseVersion: 1, targetVersion: 2,
			proposedContent: "merged content", diff: "+ merged content", status: "Pending", createdAt: new Date(),
		});
		const prisma = {
			companyDoc: { findUnique: vi.fn().mockResolvedValue({ id: "d1", currentVersion: 2 }) },
			tenant: { findUnique: vi.fn().mockResolvedValue({ name: "t1" }) },
			tenantWorkspaceDoc: { findUnique: vi.fn().mockResolvedValue({ content: "theirs", lastReconciledVersion: 1 }) },
			companyDocVersion: { findUnique: vi.fn().mockResolvedValue({ content: "some-version" }) },
			docMergeProposal: { upsert },
		} as unknown as PrismaClient;

		const out = await _ReconcileTenantDoc(prisma, _STUB_RECONCILER, "SOUL", "t1");
		expect(out.kind).toBe("proposed");
		if (out.kind === "proposed")
		{
			expect(out.proposal).toMatchObject({ id: "p1", targetVersion: 2, status: "pending" });
		}
		expect(upsert).toHaveBeenCalledOnce();
	});

	it("returns no-company-version when nothing is published", async function _nocv()
	{
		const prisma = {
			companyDoc: { findUnique: vi.fn().mockResolvedValue({ id: "d1", currentVersion: 0 }) },
		} as unknown as PrismaClient;
		const out = await _ReconcileTenantDoc(prisma, _STUB_RECONCILER, "SOUL", "t1");
		expect(out.kind).toBe("no-company-version");
	});
});

describe("_DecideProposal (P4C.5)", function _suite()
{
	function _pendingProposal()
	{
		return { id: "p1", tenant: "t1", docName: "SOUL", targetVersion: 2, proposedContent: "merged", status: "Pending" };
	}

	it("approve delivers the doc to the tenant workspace and advances the cursor", async function _approve()
	{
		const wsUpsert = vi.fn().mockResolvedValue({});
		const propUpdate = vi.fn().mockResolvedValue({});
		const tx = { tenantWorkspaceDoc: { upsert: wsUpsert }, docMergeProposal: { update: propUpdate } };
		const prisma = {
			docMergeProposal: { findUnique: vi.fn().mockResolvedValue(_pendingProposal()) },
			$transaction: vi.fn().mockImplementation(function _run(fn: (t: typeof tx) => unknown) { return fn(tx); }),
		} as unknown as PrismaClient;

		const result = await _DecideProposal(prisma, "SOUL", "p1", "approve", "owner@acme.com");
		expect(result).toEqual({ id: "p1", status: "approved", deliveredVersion: 2 });
		expect(wsUpsert).toHaveBeenCalledWith(expect.objectContaining({
			where: { tenant_docName: { tenant: "t1", docName: "SOUL" } },
		}));
	});

	it("reject flips status only and leaves the tenant doc untouched", async function _reject()
	{
		const update = vi.fn().mockResolvedValue({});
		const prisma = {
			docMergeProposal: { findUnique: vi.fn().mockResolvedValue(_pendingProposal()), update },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await _DecideProposal(prisma, "SOUL", "p1", "reject", "owner@acme.com");
		expect(result).toEqual({ id: "p1", status: "rejected", deliveredVersion: null });
		// No workspace delivery on reject.
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledOnce();
	});

	it("throws when the proposal is already decided", async function _already()
	{
		const prisma = {
			docMergeProposal: { findUnique: vi.fn().mockResolvedValue({ ...(_pendingProposal()), status: "Approved" }) },
		} as unknown as PrismaClient;
		await expect(_DecideProposal(prisma, "SOUL", "p1", "approve", "owner@acme.com")).rejects.toThrow(/already/);
	});

	it("returns null when the proposal is missing or belongs to another doc", async function _missing()
	{
		const prisma = {
			docMergeProposal: { findUnique: vi.fn().mockResolvedValue(null) },
		} as unknown as PrismaClient;
		expect(await _DecideProposal(prisma, "SOUL", "p1", "approve", "owner@acme.com")).toBeNull();
	});
});
