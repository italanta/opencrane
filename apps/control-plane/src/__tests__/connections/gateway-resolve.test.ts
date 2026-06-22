import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _ResolveGatewayTarget } from "../../core/connections/gateway-resolve.js";

/** Build a Prisma stub whose `tenant.findMany` returns the supplied matches. */
function _buildPrisma(matches: Array<{ name: string; clusterTenantRef: string | null }>)
{
	const findMany = vi.fn().mockResolvedValue(matches);
	const prisma = { tenant: { findMany } } as unknown as PrismaClient;
	return { prisma, findMany };
}

describe("_ResolveGatewayTarget (DOMAIN.T4 routing authority)", function _suite()
{
	it("resolves the pod service in the org's bound namespace", async function ()
	{
		const { prisma } = _buildPrisma([{ name: "alice", clusterTenantRef: "acme" }]);

		const outcome = await _ResolveGatewayTarget(prisma, "default", "Alice@Example.com", "sub-1");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.resolved.user).toEqual({ email: "alice@example.com", sub: "sub-1" });
		expect(outcome.resolved.tenant).toEqual({ name: "alice", clusterTenantRef: "acme" });
		// opencrane-<org> is the cross-app namespace contract; service name is openclaw-<tenant>.
		expect(outcome.resolved.podService).toEqual({ name: "openclaw-alice", namespace: "opencrane-acme" });
	});

	it("falls back to the control-plane namespace for a tenant with no org ref", async function ()
	{
		const { prisma } = _buildPrisma([{ name: "alice", clusterTenantRef: null }]);

		const outcome = await _ResolveGatewayTarget(prisma, "control-plane-ns", "alice@example.com", "sub-1");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.resolved.podService.namespace).toBe("control-plane-ns");
	});

	it("falls back to email as the logged subject when sub is empty", async function ()
	{
		const { prisma } = _buildPrisma([{ name: "alice", clusterTenantRef: "acme" }]);

		const outcome = await _ResolveGatewayTarget(prisma, "default", "alice@example.com", "");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.resolved.user.sub).toBe("alice@example.com");
	});

	it("fails closed with NO_EMAIL when the session has no email claim", async function ()
	{
		const { prisma, findMany } = _buildPrisma([]);

		const outcome = await _ResolveGatewayTarget(prisma, "default", undefined, "sub-1");

		expect(outcome).toEqual({ ok: false, code: "NO_EMAIL" });
		// Never even queries on an empty email.
		expect(findMany).not.toHaveBeenCalled();
	});

	it("fails closed with NO_TENANT when no tenant matches", async function ()
	{
		const { prisma } = _buildPrisma([]);

		const outcome = await _ResolveGatewayTarget(prisma, "default", "ghost@example.com", "sub-1");

		expect(outcome).toEqual({ ok: false, code: "NO_TENANT" });
	});

	it("fails closed with AMBIGUOUS_TENANT when more than one tenant matches", async function ()
	{
		const { prisma } = _buildPrisma([
			{ name: "alice", clusterTenantRef: "acme" },
			{ name: "alice2", clusterTenantRef: "beta" },
		]);

		const outcome = await _ResolveGatewayTarget(prisma, "default", "shared@example.com", "sub-1");

		expect(outcome).toEqual({ ok: false, code: "AMBIGUOUS_TENANT" });
	});

	it("queries case-insensitively and caps the scan at two rows (ambiguity detection)", async function ()
	{
		const { prisma, findMany } = _buildPrisma([{ name: "alice", clusterTenantRef: "acme" }]);

		await _ResolveGatewayTarget(prisma, "default", "  Alice@Example.com  ", "sub-1");

		expect(findMany).toHaveBeenCalledWith({
			where: { email: { equals: "alice@example.com", mode: "insensitive" } },
			select: { name: true, clusterTenantRef: true },
			take: 2,
		});
	});
});
