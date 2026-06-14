import type * as k8s from "@kubernetes/client-node";
import { Prisma, type PrismaClient } from "@prisma/client";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { _RegisterInternalParticipation } from "../../routes/internal/participation.js";

/** Auth API stub that authenticates as the given ServiceAccount subject. */
function _authApi(username: string, authenticated = true): k8s.AuthenticationV1Api
{
	return {
		createTokenReview: vi.fn().mockResolvedValue({
			status: { authenticated, audiences: ["control-plane"], user: { username } },
		}),
	} as unknown as k8s.AuthenticationV1Api;
}

/** Prisma stub; participationEvent.create throws P2002 when `duplicate`. */
function _prisma(duplicate = false): PrismaClient
{
	return {
		participationEvent: {
			create: duplicate
				? vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }))
				: vi.fn().mockResolvedValue({}),
		},
		tenantParticipation: { upsert: vi.fn().mockResolvedValue({}) },
	} as unknown as PrismaClient;
}

function _app(prisma: PrismaClient, authApi: k8s.AuthenticationV1Api): Express
{
	const app = express();
	app.use(express.json());
	app.use("/api/internal/awareness/participation", _RegisterInternalParticipation(prisma, authApi));
	return app;
}

describe("internal participation ingest (P4B.5)", function _suite()
{
	it("records a new event as the token-identity tenant (201)", async function _ok()
	{
		const app = _app(_prisma(), _authApi("system:serviceaccount:tenants:alex"));
		const res = await request(app)
			.post("/api/internal/awareness/participation")
			.set("Authorization", "Bearer t")
			.send({ kind: "heartbeat", idempotencyKey: "k1", contractVersion: "awareness/v1alpha1" });
		expect(res.status).toBe(201);
		expect(res.body).toEqual({ recorded: true, duplicate: false });
	});

	it("acknowledges an at-least-once duplicate with 200 (idempotent)", async function _dup()
	{
		const app = _app(_prisma(true), _authApi("system:serviceaccount:tenants:alex"));
		const res = await request(app)
			.post("/api/internal/awareness/participation")
			.set("Authorization", "Bearer t")
			.send({ kind: "heartbeat", idempotencyKey: "k1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ recorded: false, duplicate: true });
	});

	it("401s without a token and 401s when the token is not authenticated", async function _auth()
	{
		const noToken = await request(_app(_prisma(), _authApi("x"))).post("/api/internal/awareness/participation").send({ kind: "heartbeat", idempotencyKey: "k" });
		expect(noToken.status).toBe(401);

		const unauth = _app(_prisma(), _authApi("system:serviceaccount:tenants:alex", false));
		const res = await request(unauth).post("/api/internal/awareness/participation").set("Authorization", "Bearer t").send({ kind: "heartbeat", idempotencyKey: "k" });
		expect(res.status).toBe(401);
	});

	it("400s on a bad kind or missing idempotency key", async function _validation()
	{
		const app = _app(_prisma(), _authApi("system:serviceaccount:tenants:alex"));
		const badKind = await request(app).post("/api/internal/awareness/participation").set("Authorization", "Bearer t").send({ kind: "nope", idempotencyKey: "k" });
		expect(badKind.status).toBe(400);
		const noKey = await request(app).post("/api/internal/awareness/participation").set("Authorization", "Bearer t").send({ kind: "heartbeat" });
		expect(noKey.status).toBe(400);
	});

	it("403s when the token subject is a malformed (non-ServiceAccount) identity", async function _notTenant()
	{
		const malformed = _app(_prisma(), _authApi("not-a-sa-subject"));
		const res = await request(malformed).post("/api/internal/awareness/participation").set("Authorization", "Bearer t").send({ kind: "heartbeat", idempotencyKey: "k" });
		expect(res.status).toBe(403);
	});
});
