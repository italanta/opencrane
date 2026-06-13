import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _CutTenant } from "../../core/connections/cut-tenant.js";
import { _NoopGatewayAdmin } from "../../core/connections/gateway-admin.js";
import type { GatewayRevokeParams, GatewayRevokeResult, OpenClawGatewayAdmin } from "../../core/connections/gateway-admin.types.js";

/** Gateway admin spy recording calls and returning a successful revoke. */
function _spyGatewayAdmin(): OpenClawGatewayAdmin & { calls: GatewayRevokeParams[] }
{
	const calls: GatewayRevokeParams[] = [];
	return {
		calls,
		async revokeConnections(params: GatewayRevokeParams): Promise<GatewayRevokeResult>
		{
			calls.push(params);
			return { ok: true, revokedCount: params.deviceIds?.length ?? 0 };
		},
	};
}

/** Build a Prisma stub with spyable brokeredDevice methods. */
function _buildPrisma(active: Array<{ gatewayUrl: string; deviceId: string | null }>)
{
	const updateMany = vi.fn().mockResolvedValue({ count: active.length });
	const findMany = vi.fn().mockResolvedValue(active);
	const prisma = { brokeredDevice: { findMany, updateMany } } as unknown as PrismaClient;
	return { prisma, findMany, updateMany };
}

/** Build a Core V1 client stub recording pod-delete calls. */
function _buildCoreApi()
{
	const deleteCollectionNamespacedPod = vi.fn().mockResolvedValue({});
	const coreApi = { deleteCollectionNamespacedPod } as unknown as k8s.CoreV1Api;
	return { coreApi, deleteCollectionNamespacedPod };
}

describe("_CutTenant (CONN.5 connection kill-switch)", function _suite()
{
	it("full-tenant cut: revokes at the gateway, marks rows cut, and force-deletes the pod", async function _fullCut()
	{
		const { prisma, updateMany } = _buildPrisma([
			{ gatewayUrl: "wss://t1.example.com/gateway", deviceId: "dev-a" },
			{ gatewayUrl: "wss://t1.example.com/gateway", deviceId: null },
		]);
		const { coreApi, deleteCollectionNamespacedPod } = _buildCoreApi();
		const gateway = _spyGatewayAdmin();

		const result = await _CutTenant(coreApi, prisma, gateway, { tenant: "t1", namespace: "tenants" });

		// Pod force-deleted by tenant label selector — severs live sockets.
		expect(deleteCollectionNamespacedPod).toHaveBeenCalledWith({
			namespace: "tenants",
			labelSelector: "opencrane.io/tenant=t1",
		});
		// Gateway revoke targeted only the known (non-null) device ids.
		expect(gateway.calls[0]).toMatchObject({ gatewayUrl: "wss://t1.example.com/gateway", tenant: "t1", deviceIds: ["dev-a"] });
		expect(gateway.calls[0].subject).toBeUndefined();
		// Registry rows marked revoked.
		expect(updateMany).toHaveBeenCalled();
		expect(result).toMatchObject({ tenant: "t1", scope: "tenant", revokedDevices: 2, podForceDeleted: true });
		expect(result.gatewayRevoke.ok).toBe(true);
	});

	it("subject-scoped cut: revokes the caller's connections but does NOT delete the shared pod", async function _subjectCut()
	{
		const { prisma, findMany } = _buildPrisma([{ gatewayUrl: "wss://t1.example.com/gateway", deviceId: "dev-a" }]);
		const { coreApi, deleteCollectionNamespacedPod } = _buildCoreApi();
		const gateway = _spyGatewayAdmin();

		const result = await _CutTenant(coreApi, prisma, gateway, { tenant: "t1", namespace: "tenants", subject: "user-1" });

		// The shared per-tenant pod must survive a self-serve cut.
		expect(deleteCollectionNamespacedPod).not.toHaveBeenCalled();
		// Lookup and gateway revoke were scoped to the subject.
		expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ subject: "user-1" }) }));
		expect(gateway.calls[0].subject).toBe("user-1");
		expect(result).toMatchObject({ scope: "subject", podForceDeleted: false });
	});

	it("no active connections: skips the gateway revoke but still force-deletes on a tenant cut", async function _noneActive()
	{
		const { prisma } = _buildPrisma([]);
		const { coreApi, deleteCollectionNamespacedPod } = _buildCoreApi();
		const gateway = _spyGatewayAdmin();

		const result = await _CutTenant(coreApi, prisma, gateway, { tenant: "t1", namespace: "tenants" });

		expect(gateway.calls).toHaveLength(0);
		expect(result.gatewayRevoke.ok).toBe(false);
		expect(deleteCollectionNamespacedPod).toHaveBeenCalledOnce();
		expect(result.podForceDeleted).toBe(true);
	});

	it("no-op gateway admin reports the WS revoke did not run (pod-delete is the authoritative cut)", async function _noopAdmin()
	{
		const { prisma } = _buildPrisma([{ gatewayUrl: "wss://t1.example.com/gateway", deviceId: "dev-a" }]);
		const { coreApi } = _buildCoreApi();

		const result = await _CutTenant(coreApi, prisma, new _NoopGatewayAdmin(), { tenant: "t1", namespace: "tenants" });

		expect(result.gatewayRevoke.ok).toBe(false);
		expect(result.podForceDeleted).toBe(true);
	});
});
