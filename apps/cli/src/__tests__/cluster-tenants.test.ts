import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ___CreateControlPlaneClient } from "@opencrane/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { _BuildQuotaBody } from "../commands/cluster-tenants.js";

/** A persisted cluster-tenant row in the mock server's in-memory store. */
type Row = Record<string, unknown>;

/** In-memory store backing the mock control-plane server, keyed by name. */
const _store = new Map<string, Row>();

/** Mock control-plane server mimicking the /api/v1/cluster-tenants routes. */
let _server: Server;
/** Base URL (including /api/v1) the generated client is pointed at. */
let _baseUrl: string;

/**
 * Read and JSON-parse a request body.
 *
 * @param req - The incoming HTTP request.
 * @returns The parsed body, or an empty object when there is no body.
 */
async function _readBody(req: IncomingMessage): Promise<Row>
{
  const chunks: Buffer[] = [];
  for await (const chunk of req)
  {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Row) : {};
}

/**
 * Write a JSON response with the given status code.
 *
 * @param res    - The server response.
 * @param status - HTTP status code.
 * @param body   - JSON-serialisable response body.
 */
function _sendJson(res: ServerResponse, status: number, body: unknown): void
{
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Project a stored row into the ClusterTenant contract shape the API returns.
 *
 * @param row - The persisted row.
 * @returns The contract representation.
 */
function _toContract(row: Row): Row
{
  return {
    name: row.name,
    displayName: row.displayName,
    isolationTier: row.isolationTier,
    compute: row.compute,
    resources: row.resources,
    status: { phase: "pending" },
  };
}

/**
 * Route a single request against the in-memory store, reproducing the real
 * route handler's status codes — including 422 TIER_UNAVAILABLE for an
 * over-tier (dedicatedCluster) request with no backend registered.
 *
 * @param req - Incoming request.
 * @param res - Server response.
 */
async function _route(req: IncomingMessage, res: ServerResponse): Promise<void>
{
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const segments = path.split("/").filter(Boolean);

  // 1. Collection routes: list (GET) and create (POST).
  if (segments.length === 1 && segments[0] === "cluster-tenants")
  {
    if (req.method === "GET")
    {
      _sendJson(res, 200, Array.from(_store.values()).map(_toContract));
      return;
    }
    if (req.method === "POST")
    {
      const body = await _readBody(req);
      // dedicatedCluster has no registered backend in this mock — reject 422.
      if (body.isolationTier === "dedicatedCluster")
      {
        _sendJson(res, 422, { error: "No provisioner is registered for isolation tier 'dedicatedCluster'.", code: "TIER_UNAVAILABLE" });
        return;
      }
      _store.set(body.name as string, body);
      _sendJson(res, 201, _toContract(body));
      return;
    }
  }

  // 2. Item routes: show/update/delete on /cluster-tenants/{name}.
  if (segments.length === 2 && segments[0] === "cluster-tenants")
  {
    const name = decodeURIComponent(segments[1] ?? "");
    const existing = _store.get(name);
    if (req.method === "GET")
    {
      if (!existing) { _sendJson(res, 404, { error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" }); return; }
      _sendJson(res, 200, _toContract(existing));
      return;
    }
    if (req.method === "PUT")
    {
      if (!existing) { _sendJson(res, 404, { error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" }); return; }
      const body = await _readBody(req);
      const merged = { ...existing, ...body };
      _store.set(name, merged);
      _sendJson(res, 200, _toContract(merged));
      return;
    }
    if (req.method === "DELETE")
    {
      _store.delete(name);
      _sendJson(res, 200, { name, status: "deleted" });
      return;
    }
  }

  // 3. Status route: GET /cluster-tenants/{name}/status.
  if (segments.length === 3 && segments[0] === "cluster-tenants" && segments[2] === "status")
  {
    const name = decodeURIComponent(segments[1] ?? "");
    const existing = _store.get(name);
    if (!existing) { _sendJson(res, 404, { error: "Cluster tenant not found", code: "CLUSTER_TENANT_NOT_FOUND" }); return; }
    _sendJson(res, 200, { phase: "pending" });
    return;
  }

  _sendJson(res, 404, { error: "not found" });
}

beforeAll(async function _startServer()
{
  _server = createServer(function _handler(req, res) { void _route(req, res); });
  await new Promise<void>(function _listen(resolve) { _server.listen(0, resolve); });
  const port = (_server.address() as AddressInfo).port;
  _baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async function _stopServer()
{
  await new Promise<void>(function _close(resolve) { _server.close(function _onClose() { resolve(); }); });
});

describe("_BuildQuotaBody", function _quotaSuite()
{
  it("includes only supplied flags and coerces numeric fields", function _coerces()
  {
    const quota = _BuildQuotaBody({ quotaCpu: "4", quotaMemory: "8Gi", quotaPods: "20", quotaGpu: "2" });
    expect(quota).toEqual({ cpu: "4", memory: "8Gi", pods: 20, gpu: 2 });
  });

  it("returns an empty object when no quota flags are set", function _empty()
  {
    expect(_BuildQuotaBody({})).toEqual({});
  });
});

describe("oc cluster-tenant — control-plane client round-trip", function _crudSuite()
{
  it("creates, lists, shows, reads status, updates, and deletes via the generated client", async function _crud()
  {
    const client = ___CreateControlPlaneClient(_baseUrl, "test-token");

    // 1. Create (shared tier).
    const created = await client.POST("/cluster-tenants", {
      body: {
        name: "acme",
        displayName: "Acme Corp",
        isolationTier: "shared",
        compute: { mode: "shared" },
        resources: { quota: _BuildQuotaBody({ quotaCpu: "4", quotaMemory: "8Gi" }) },
      },
    });
    expect(created.error).toBeUndefined();
    expect(created.data).toMatchObject({ name: "acme", isolationTier: "shared", status: { phase: "pending" } });

    // 2. List + show.
    const list = await client.GET("/cluster-tenants");
    expect(list.data).toHaveLength(1);
    const show = await client.GET("/cluster-tenants/{name}", { params: { path: { name: "acme" } } });
    expect(show.data?.displayName).toBe("Acme Corp");

    // 3. Status read.
    const status = await client.GET("/cluster-tenants/{name}/status", { params: { path: { name: "acme" } } });
    expect(status.data?.phase).toBe("pending");

    // 4. Update + delete.
    const updated = await client.PUT("/cluster-tenants/{name}", { params: { path: { name: "acme" } }, body: { displayName: "Acme Inc" } });
    expect(updated.data?.displayName).toBe("Acme Inc");
    const deleted = await client.DELETE("/cluster-tenants/{name}", { params: { path: { name: "acme" } } });
    expect(deleted.error).toBeUndefined();
  });

  it("surfaces a 422 TIER_UNAVAILABLE envelope (clean error, not a throw) for an over-tier request", async function _overTier()
  {
    const client = ___CreateControlPlaneClient(_baseUrl, "test-token");

    // An over-tier dedicatedCluster create returns a typed error envelope —
    // openapi-fetch resolves (does not throw), so the CLI's _PrintApiError can
    // format `${error} [${code}]` instead of dumping a stack trace.
    const res = await client.POST("/cluster-tenants", {
      body: {
        name: "globex",
        displayName: "Globex",
        isolationTier: "dedicatedCluster",
        compute: { mode: "dedicated", nodePool: "globex-pool" },
        resources: { quota: { cpu: "8" } },
      },
    });

    expect(res.data).toBeUndefined();
    const error = res.error as { error: string; code: string };
    expect(error.code).toBe("TIER_UNAVAILABLE");
    expect(error.error).toContain("dedicatedCluster");
  });
});
