import type * as k8s from "@kubernetes/client-node";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { ___AuthRouter } from "../../infra/auth/auth.router.js";
import type { OidcAuthService } from "../../infra/auth/oidc.service.js";
import { _NoopGatewayAdmin } from "../../core/connections/gateway-admin.js";

/** Session shape the pod-token route reads. */
interface TestSession
{
	/** Authenticated user, or undefined for an anonymous request. */
	authUser?: { sub: string; email?: string };
}

/** Core V1 client stub; the broker records a device but never touches k8s. */
const _CORE_API = {} as k8s.CoreV1Api;

/** Build a Prisma stub whose tenant.findMany returns the given matches. */
function _buildPrisma(matches: unknown[]): PrismaClient
{
	return {
		tenant: { findMany: vi.fn().mockResolvedValue(matches) },
		brokeredDevice: { upsert: vi.fn().mockResolvedValue({}) },
	} as unknown as PrismaClient;
}

/** Mount the auth router with an injected session for testing. */
function _buildApp(session: TestSession, prisma: PrismaClient): Express
{
	const app = express();
	app.use(express.json());
	app.use(function _injectSession(req: Request, _res: Response, next: NextFunction): void
	{
		(req as unknown as { session: TestSession }).session = session;
		next();
	});
	app.use("/auth", ___AuthRouter({} as OidcAuthService, prisma, _CORE_API, new _NoopGatewayAdmin()));
	return app;
}

describe("POST /auth/pod-token (OpenClaw connection broker)", function _suite()
{
	it("returns the gateway connection coordinates for the caller's tenant", async function _ok()
	{
		const prisma = _buildPrisma([{
			name: "alex.oc",
			ingressHost: "alex.oc.example.com",
			configOverrides: { openclaw: { gatewayUrl: "wss://alex.oc.example.com/gateway" } },
		}]);
		const app = _buildApp({ authUser: { sub: "u1", email: "Alex@acme.com" } }, prisma);

		const res = await request(app).post("/auth/pod-token");

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			gatewayUrl: "wss://alex.oc.example.com/gateway",
			tenant: "alex.oc",
			ingressHost: "alex.oc.example.com",
		});
	});

	it("derives the gateway URL from ingressHost when no pairing is stored, routed at /gateway", async function _derived()
	{
		const prisma = _buildPrisma([{ name: "alex.oc", ingressHost: "alex.oc.example.com", configOverrides: null }]);
		const app = _buildApp({ authUser: { sub: "u1", email: "alex@acme.com" } }, prisma);

		const res = await request(app).post("/auth/pod-token");

		expect(res.status).toBe(200);
		// Same-origin hosting: the SPA owns `/`, so the WS is exposed at `/gateway`.
		expect(res.body.gatewayUrl).toBe("wss://alex.oc.example.com/gateway");
	});

	it("returns 401 without a session", async function _noSession()
	{
		const app = _buildApp({}, _buildPrisma([]));
		const res = await request(app).post("/auth/pod-token");
		expect(res.status).toBe(401);
		expect(res.body.code).toBe("UNAUTHORIZED");
	});

	it("returns 403 when the session has no email", async function _noEmail()
	{
		const app = _buildApp({ authUser: { sub: "u1" } }, _buildPrisma([]));
		const res = await request(app).post("/auth/pod-token");
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("FORBIDDEN");
	});

	it("returns 403 when no tenant matches the session email", async function _noTenant()
	{
		const app = _buildApp({ authUser: { sub: "u1", email: "ghost@acme.com" } }, _buildPrisma([]));
		const res = await request(app).post("/auth/pod-token");
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("NO_TENANT");
	});

	it("fails closed with 409 when the email maps to more than one tenant", async function _ambiguous()
	{
		const prisma = _buildPrisma([
			{ name: "alex.oc", ingressHost: "a.example.com", configOverrides: null },
			{ name: "alex2.oc", ingressHost: "b.example.com", configOverrides: null },
		]);
		const app = _buildApp({ authUser: { sub: "u1", email: "alex@acme.com" } }, prisma);
		const res = await request(app).post("/auth/pod-token");
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("AMBIGUOUS_TENANT");
	});

	it("scopes the tenant lookup to the silo in the request host so a multi-silo owner resolves", async function _hostScoped()
	{
		// A multi-silo owner: an unscoped lookup would be ambiguous (409). The request host
		// (`<clusterTenant>.<base>`) scopes the query to the silo being connected through.
		const prisma = _buildPrisma([{ name: "elewa-be-default", ingressHost: "elewa-be.dev.opencrane.ai", configOverrides: null }]);
		const app = _buildApp({ authUser: { sub: "u1", email: "jente@elewa.ke" } }, prisma);

		const res = await request(app).post("/auth/pod-token").set("x-forwarded-host", "elewa-be.dev.opencrane.ai");

		expect(res.status).toBe(200);
		expect(res.body.tenant).toBe("elewa-be-default");
		expect((prisma.tenant.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
			where: { email: { equals: "jente@elewa.ke", mode: "insensitive" }, clusterTenantRef: "elewa-be" },
		}));
	});

	it("returns 409 when the pod is neither paired nor has an ingress host", async function _notReady()
	{
		const prisma = _buildPrisma([{ name: "alex.oc", ingressHost: null, configOverrides: null }]);
		const app = _buildApp({ authUser: { sub: "u1", email: "alex@acme.com" } }, prisma);
		const res = await request(app).post("/auth/pod-token");
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("POD_NOT_READY");
	});
});
