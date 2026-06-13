import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { _RecordBrokeredDevice } from "../../infra/auth/brokered-device.js";

describe("_RecordBrokeredDevice (CONN.4 device registry)", function _suite()
{
	it("upserts a (tenant, subject) row, refreshing the URL and clearing any prior revoke", async function _upsert()
	{
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = { brokeredDevice: { upsert } } as unknown as PrismaClient;

		await _RecordBrokeredDevice(prisma, { tenant: "t1", subject: "user-1", gatewayUrl: "wss://t1.example.com/gateway" });

		expect(upsert).toHaveBeenCalledWith({
			where: { tenant_subject: { tenant: "t1", subject: "user-1" } },
			create: { tenant: "t1", subject: "user-1", gatewayUrl: "wss://t1.example.com/gateway" },
			update: { gatewayUrl: "wss://t1.example.com/gateway", revokedAt: null },
		});
	});
});
