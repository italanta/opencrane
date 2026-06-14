import type { PrismaClient } from "@prisma/client";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { sessionsRouter } from "../../routes/sessions.js";

/** A Prisma grant row in the shape `compile()` selects (Prisma enum string values). */
function _grant(payloadId: string, access: "Allow" | "Deny", scope: "Org" | "Project"): Record<string, unknown>
{
	return {
		id: `g-${payloadId}`,
		payloadType: "Awareness",
		payloadId,
		access,
		priority: 0,
		scope,
		subjectType: "Tenant",
		subjectId: "t1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

/**
 * Build a Prisma stub: `compile()` reads groups + grants; the session-scope
 * registry is an in-memory row so PUT/GET/DELETE round-trip.
 */
function _buildPrisma(grants: Record<string, unknown>[])
{
	const store: { row: Record<string, unknown> | null } = { row: null };
	const prisma = {
		group: { findMany: vi.fn().mockResolvedValue([]) },
		grant: { findMany: vi.fn().mockResolvedValue(grants) },
		sessionScope: {
			findUnique: vi.fn().mockImplementation(function _find() { return Promise.resolve(store.row); }),
			upsert: vi.fn().mockImplementation(function _upsert(args: { create: Record<string, unknown> })
			{
				store.row = { createdAt: new Date("2026-06-14T00:00:00.000Z"), updatedAt: new Date("2026-06-14T00:00:00.000Z"), ...args.create };
				return Promise.resolve(store.row);
			}),
			deleteMany: vi.fn().mockImplementation(function _del()
			{
				const had = store.row !== null;
				store.row = null;
				return Promise.resolve({ count: had ? 1 : 0 });
			}),
		},
	} as unknown as PrismaClient;
	return { prisma, store };
}

function _app(prisma: PrismaClient): Express
{
	const app = express();
	app.use(express.json());
	app.use("/sessions", sessionsRouter(prisma));
	return app;
}

describe("sessions scope router (P4B.7)", function _suite()
{
	it("PUT stores the entitled intersection and reports rejected over-scope", async function _bind()
	{
		const { prisma } = _buildPrisma([
			_grant("proj-x", "Allow", "Project"),
			_grant("org-acme", "Allow", "Org"),
		]);
		const res = await request(_app(prisma)).put("/sessions/sess-1/scope").send({
			principal: "t1",
			scopes: [
				{ scope: "project", payloadId: "proj-x" },
				{ scope: "project", payloadId: "proj-y" }, // not entitled
				{ scope: "org", payloadId: "org-acme" },
			],
		});
		expect(res.status).toBe(200);
		expect(res.body.sessionKey).toBe("sess-1");
		expect(res.body.scopes).toEqual([
			{ scope: "project", payloadId: "proj-x" },
			{ scope: "org", payloadId: "org-acme" },
		]);
		expect(res.body.rejected).toEqual([{ scope: "project", payloadId: "proj-y" }]);
	});

	it("PUT 403s when nothing requested is entitled (pure over-scope)", async function _overScope()
	{
		const { prisma } = _buildPrisma([_grant("proj-x", "Allow", "Project")]);
		const res = await request(_app(prisma)).put("/sessions/sess-2/scope").send({
			principal: "t1",
			scopes: [{ scope: "project", payloadId: "proj-secret" }],
		});
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("OVER_SCOPE");
		expect(res.body.rejected).toEqual([{ scope: "project", payloadId: "proj-secret" }]);
	});

	it("PUT 400s without a principal or with empty scopes", async function _validation()
	{
		const { prisma } = _buildPrisma([]);
		const app = _app(prisma);
		expect((await request(app).put("/sessions/s/scope").send({ scopes: [{ scope: "org", payloadId: "x" }] })).status).toBe(400);
		expect((await request(app).put("/sessions/s/scope").send({ principal: "t1", scopes: [] })).status).toBe(400);
	});

	it("end-to-end: a Deny grant is rejected and a client-claimed broader scope is overridden", async function _denyAndSpoof()
	{
		const { prisma } = _buildPrisma([
			_grant("proj-x", "Deny", "Project"),   // entitled? no — denied
			_grant("proj-y", "Allow", "Project"),  // entitled at project level
		]);
		const res = await request(_app(prisma)).put("/sessions/sess-d/scope").send({
			principal: "t1",
			scopes: [
				{ scope: "project", payloadId: "proj-x" },   // denied → rejected
				{ scope: "org", payloadId: "proj-y" },        // claims org, grant says project
			],
		});
		expect(res.status).toBe(200);
		// proj-y stored at its authoritative "project" scope, not the claimed "org".
		expect(res.body.scopes).toEqual([{ scope: "project", payloadId: "proj-y" }]);
		expect(res.body.rejected).toEqual([{ scope: "project", payloadId: "proj-x" }]);
	});

	it("DELETE on an unbound session 404s", async function _deleteMissing()
	{
		const { prisma } = _buildPrisma([]);
		const res = await request(_app(prisma)).delete("/sessions/never-bound/scope");
		expect(res.status).toBe(404);
		expect(res.body.cleared).toBe(false);
	});

	it("GET 404s when unbound, then reflects the stored binding; DELETE clears it", async function _lifecycle()
	{
		const { prisma } = _buildPrisma([_grant("proj-x", "Allow", "Project")]);
		const app = _app(prisma);

		expect((await request(app).get("/sessions/sess-3/scope")).status).toBe(404);

		await request(app).put("/sessions/sess-3/scope").send({ principal: "t1", scopes: [{ scope: "project", payloadId: "proj-x" }] });
		const got = await request(app).get("/sessions/sess-3/scope");
		expect(got.status).toBe(200);
		expect(got.body.scopes).toEqual([{ scope: "project", payloadId: "proj-x" }]);

		const cleared = await request(app).delete("/sessions/sess-3/scope");
		expect(cleared.status).toBe(200);
		expect(cleared.body.cleared).toBe(true);
		expect((await request(app).get("/sessions/sess-3/scope")).status).toBe(404);
	});
});
