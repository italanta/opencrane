import type { PrismaClient } from "@prisma/client";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { _RegisterInternalTenantModels } from "../../../routes/internal/tenant-models.js";

/** A model-definition row as projected by the route's `select`. */
interface ModelRow
{
	/** Public model name the tenant may reference. */
	publicModelName: string;
	/** Whether this model is the registry-level default for its scope. */
	isDefault: boolean;
}

/** Options describing the fake database state for one test app. */
interface FakeDbOptions
{
	/** clusterTenantRef the tenant resolves to, or null. Undefined means the tenant is unknown. */
	clusterTenantRef?: string | null;
	/** Model-definition rows the `findMany` should return for the route's scope filter. */
	definitions: ModelRow[];
	/** ClusterTenant-scoped routing default model, or null when no CT default row exists. */
	ctDefault?: string | null;
	/** Global routing default model, or null when no Global default row exists. */
	globalDefault?: string | null;
}

/**
 * Build a Prisma stub that honours the route's scope filter and default lookups.
 *
 * `modelDefinition.findMany` echoes the configured rows; `modelRoutingDefault`
 * resolves by the composite `scope_clusterTenant` key the route uses.
 *
 * @param opts - Fake database state for this app.
 * @returns A Prisma-shaped stub for the internal tenant-models route.
 */
function _prisma(opts: FakeDbOptions): PrismaClient
{
	const tenantRow = opts.clusterTenantRef === undefined ? null : { clusterTenantRef: opts.clusterTenantRef };
	return {
		tenant: {
			findUnique: vi.fn().mockResolvedValue(tenantRow),
		},
		modelDefinition: {
			findMany: vi.fn().mockResolvedValue(opts.definitions),
		},
		modelRoutingDefault: {
			findFirst: vi.fn().mockImplementation(function _find(args: { where: { scope: string } })
			{
				const scope = args.where.scope;
				if (scope === "ClusterTenant")
				{
					return Promise.resolve(opts.ctDefault === undefined ? null : { defaultModel: opts.ctDefault });
				}
				return Promise.resolve(opts.globalDefault === undefined ? null : { defaultModel: opts.globalDefault });
			}),
		},
	} as unknown as PrismaClient;
}

/**
 * Mount the internal tenant-models router on a bare Express app.
 *
 * @param prisma - Prisma stub for the route.
 * @returns The configured Express app.
 */
function _app(prisma: PrismaClient): Express
{
	const app = express();
	app.use(express.json());
	app.use("/api/internal/tenant-models", _RegisterInternalTenantModels(prisma));
	return app;
}

describe("internal tenant-models allowlist", function _suite()
{
	it("returns global-only models for a tenant with no clusterTenantRef", async function _globalNoCt()
	{
		const app = _app(_prisma({
			clusterTenantRef: null,
			definitions: [{ publicModelName: "gpt-4o", isDefault: false }, { publicModelName: "claude-sonnet", isDefault: false }],
			globalDefault: "gpt-4o",
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.status).toBe(200);
		expect(res.body.models.sort()).toEqual(["claude-sonnet", "gpt-4o"]);
		expect(res.body.defaultModel).toBe("gpt-4o");
	});

	it("returns global-only models for an unknown tenant (best-effort, no 404)", async function _unknown()
	{
		const app = _app(_prisma({
			clusterTenantRef: undefined,
			definitions: [{ publicModelName: "gpt-4o", isDefault: false }],
			globalDefault: "gpt-4o",
		}));
		const res = await request(app).get("/api/internal/tenant-models/nope");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ models: ["gpt-4o"], defaultModel: "gpt-4o" });
	});

	it("returns global + CT-scoped models for a tenant with a clusterTenantRef", async function _withCt()
	{
		const app = _app(_prisma({
			clusterTenantRef: "ct-acme",
			definitions: [
				{ publicModelName: "gpt-4o", isDefault: false },
				{ publicModelName: "acme-llama", isDefault: false },
			],
			globalDefault: "gpt-4o",
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.status).toBe(200);
		expect(res.body.models.sort()).toEqual(["acme-llama", "gpt-4o"]);
	});

	it("de-duplicates a model name present at both Global and CT scope", async function _dedup()
	{
		const app = _app(_prisma({
			clusterTenantRef: "ct-acme",
			definitions: [
				{ publicModelName: "gpt-4o", isDefault: false },
				{ publicModelName: "gpt-4o", isDefault: false },
			],
			globalDefault: null,
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.status).toBe(200);
		expect(res.body.models).toEqual(["gpt-4o"]);
	});

	it("resolves the CT default ahead of the global default", async function _ctWins()
	{
		const app = _app(_prisma({
			clusterTenantRef: "ct-acme",
			definitions: [{ publicModelName: "gpt-4o", isDefault: true }],
			ctDefault: "acme-llama",
			globalDefault: "gpt-4o",
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.body.defaultModel).toBe("acme-llama");
	});

	it("falls back to the global default when no CT default exists", async function _globalDefault()
	{
		const app = _app(_prisma({
			clusterTenantRef: "ct-acme",
			definitions: [{ publicModelName: "gpt-4o", isDefault: true }],
			globalDefault: "gpt-4o",
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.body.defaultModel).toBe("gpt-4o");
	});

	it("falls back to the isDefault model when no routing-default row exists", async function _isDefaultFallback()
	{
		const app = _app(_prisma({
			clusterTenantRef: null,
			definitions: [
				{ publicModelName: "gpt-4o", isDefault: false },
				{ publicModelName: "claude-sonnet", isDefault: true },
			],
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.body.defaultModel).toBe("claude-sonnet");
	});

	it("returns a null default when nothing resolves", async function _nullDefault()
	{
		const app = _app(_prisma({
			clusterTenantRef: null,
			definitions: [{ publicModelName: "gpt-4o", isDefault: false }],
		}));
		const res = await request(app).get("/api/internal/tenant-models/alex");
		expect(res.body.defaultModel).toBeNull();
	});
});
