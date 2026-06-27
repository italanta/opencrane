import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { approveServer, clearCredential, connectOauth, disconnectOauth, getAccessPolicy, getDirectory, installServer, listAllServers, listEntitledCatalog, listInstalled, publishServer, rejectServer, setAccessPolicy, setCredential, setServerEnabled, uninstallServer, type McpOperatorCaller } from "../core/mcp-operator/mcp-operator.logic.js";
import { _IsDevAuthMode } from "../infra/auth/auth-mode.js";
import { _RequireOrgAdmin } from "../infra/middleware/require-org-admin.js";
import type { McpAccessPolicyRequest, McpEnabledRequest, McpInstallRequest } from "./mcp-operator.types.js";

/**
 * Operator-API router for the MCP consumption + governance surface (`/api/v1/mcp/*`).
 *
 * Layers the entitlement-scoped catalogue, per-user installs / credential connect,
 * and org-admin governance + access-policy endpoints ON TOP of the existing
 * `/mcp-servers` admin registry (which stays as-is). Two authorization postures:
 *
 * - **User-facing** (`/catalog`, `/installed/*`) — scoped to the calling user via
 *   {@link _ResolveCaller}; entitlement filtering decides catalogue visibility.
 * - **Admin** (`/servers/*`, `/directory`) — gated by `_RequireOrgAdmin`, matching
 *   the registry's curate-is-an-admin-action posture (fail-open dev / fail-closed real auth).
 *
 * Custody: no response on any route serialises credential material — a connected
 * install reports only its connection status (the secret is brokered by the gateway plane).
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function mcpOperatorRouter(prisma: PrismaClient): Router
{
  const router = Router();

  // -------------------------------------------------------------------------
  // User-facing — entitlement-scoped catalogue + per-user installs
  // -------------------------------------------------------------------------

  /** List the published servers the calling user is entitled to. */
  router.get("/catalog", async function _listCatalog(req, res)
  {
    res.json(await listEntitledCatalog(prisma, _ResolveCaller(req)));
  });

  /** List the servers the calling user has installed. */
  router.get("/installed", async function _listInstalled(req, res)
  {
    res.json(await listInstalled(prisma, _ResolveCaller(req).userId));
  });

  /** Install a catalogue server for the calling user. */
  router.post("/installed", async function _install(req, res)
  {
    const body = req.body as McpInstallRequest;
    if (typeof body?.serverId !== "string" || body.serverId.trim().length === 0)
    {
      res.status(400).json({ error: "serverId is required", code: "VALIDATION_ERROR" });
      return;
    }

    const installed = await installServer(prisma, _ResolveCaller(req).userId, body.serverId.trim());
    if (!installed)
    {
      res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
      return;
    }

    res.status(201).json(installed);
  });

  /** Uninstall a server for the calling user; clears any stored credential. */
  router.delete("/installed/:serverId", async function _uninstall(req: Request<{ serverId: string }>, res)
  {
    const removed = await uninstallServer(prisma, _ResolveCaller(req).userId, req.params.serverId);
    if (!removed)
    {
      res.status(404).json({ error: "MCP install not found", code: "MCP_INSTALL_NOT_FOUND" });
      return;
    }

    res.status(204).end();
  });

  /** Author a per-user credential (WRITE-ONLY) and mark the install connected. */
  router.put("/installed/:serverId/credential", async function _setCredential(req: Request<{ serverId: string }>, res)
  {
    // The submitted `values` are accepted but never persisted as plaintext nor
    // returned — setCredential mints an opaque custody handle in their place.
    const installed = await setCredential(prisma, _ResolveCaller(req).userId, req.params.serverId);
    _sendInstallOrNotFound(res, installed);
  });

  /** Clear a per-user credential, returning the install to needs-credential. */
  router.delete("/installed/:serverId/credential", async function _clearCredential(req: Request<{ serverId: string }>, res)
  {
    const installed = await clearCredential(prisma, _ResolveCaller(req).userId, req.params.serverId);
    _sendInstallOrNotFound(res, installed);
  });

  /** Mark a remote-OAuth install connected after a successful handshake. */
  router.post("/installed/:serverId/oauth", async function _connectOauth(req: Request<{ serverId: string }>, res)
  {
    const installed = await connectOauth(prisma, _ResolveCaller(req).userId, req.params.serverId);
    _sendInstallOrNotFound(res, installed);
  });

  /** Disconnect a remote-OAuth install, returning it to needs-credential. */
  router.delete("/installed/:serverId/oauth", async function _disconnectOauth(req: Request<{ serverId: string }>, res)
  {
    const installed = await disconnectOauth(prisma, _ResolveCaller(req).userId, req.params.serverId);
    _sendInstallOrNotFound(res, installed);
  });

  // -------------------------------------------------------------------------
  // Admin — governance + access policy (org-admin gated)
  // -------------------------------------------------------------------------

  /** List every catalogue server regardless of status (governance view). Org-admin only. */
  router.get("/servers", _RequireOrgAdmin(), async function _listServers(req, res)
  {
    res.json(await listAllServers(prisma));
  });

  /** Approve a server (pending-review → approved). Org-admin only. */
  router.post("/servers/:id/approve", _RequireOrgAdmin(), async function _approve(req: Request<{ id: string }>, res)
  {
    _sendServerOrNotFound(res, await approveServer(prisma, req.params.id));
  });

  /** Publish a server (approved → published). Org-admin only. */
  router.post("/servers/:id/publish", _RequireOrgAdmin(), async function _publish(req: Request<{ id: string }>, res)
  {
    _sendServerOrNotFound(res, await publishServer(prisma, req.params.id));
  });

  /** Reject a server (→ disabled). Org-admin only. */
  router.post("/servers/:id/reject", _RequireOrgAdmin(), async function _reject(req: Request<{ id: string }>, res)
  {
    _sendServerOrNotFound(res, await rejectServer(prisma, req.params.id));
  });

  /** Toggle a server's availability (true → published, false → disabled). Org-admin only. */
  router.post("/servers/:id/enabled", _RequireOrgAdmin(), async function _setEnabled(req: Request<{ id: string }>, res)
  {
    const body = req.body as McpEnabledRequest;
    if (typeof body?.enabled !== "boolean")
    {
      res.status(400).json({ error: "enabled (boolean) is required", code: "VALIDATION_ERROR" });
      return;
    }

    _sendServerOrNotFound(res, await setServerEnabled(prisma, req.params.id, body.enabled));
  });

  /** Read a server's access policy. Org-admin only. */
  router.get("/servers/:id/access", _RequireOrgAdmin(), async function _getAccess(req: Request<{ id: string }>, res)
  {
    const policy = await getAccessPolicy(prisma, req.params.id);
    if (!policy)
    {
      res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
      return;
    }

    res.json(policy);
  });

  /** Replace a server's access policy wholesale. Org-admin only. */
  router.put("/servers/:id/access", _RequireOrgAdmin(), async function _setAccess(req: Request<{ id: string }>, res)
  {
    const body = req.body as McpAccessPolicyRequest;
    if (typeof body?.everyoneInOrg !== "boolean" || !Array.isArray(body.groups) || !Array.isArray(body.users))
    {
      res.status(400).json({ error: "everyoneInOrg (boolean), groups (array), and users (array) are required", code: "VALIDATION_ERROR" });
      return;
    }

    const policy = await setAccessPolicy(prisma, req.params.id, body);
    if (!policy)
    {
      res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
      return;
    }

    res.json(policy);
  });

  /** List the selectable users and groups for the access editor. Org-admin only. */
  router.get("/directory", _RequireOrgAdmin(), async function _directory(req, res)
  {
    res.json(await getDirectory(prisma));
  });

  return router;
}

/**
 * Resolve the calling user's identity + entitlement context from the session.
 *
 * Mirrors the platform's fail-open dev posture: an established session uses the
 * IdP-verified identity; an unauthenticated caller under dev-auth-mode is treated
 * as dev-open (full catalogue), and otherwise as an unknown caller (fail closed).
 *
 * @param req - Incoming request carrying the optional auth session.
 * @returns The resolved caller context.
 */
function _ResolveCaller(req: Request): McpOperatorCaller
{
  // 1. Established session — derive the stable id and group claims from the IdP.
  const authUser = req.session?.authUser;
  if (authUser)
  {
    return { userId: authUser.sub ?? authUser.email ?? "unknown", groups: authUser.groups ?? [], devOpen: false };
  }

  // 2. No session under dev-auth-mode — open the catalogue so local dev isn't locked out.
  if (_IsDevAuthMode())
  {
    return { userId: "dev-user", groups: [], devOpen: true };
  }

  // 3. No session under real auth — fail closed (empty groups, not dev-open).
  return { userId: "unknown", groups: [], devOpen: false };
}

/**
 * Send an install response or a 404 when the install / server was absent.
 *
 * @param res - Express response.
 * @param installed - Install payload, or null when not found.
 */
function _sendInstallOrNotFound(res: Response, installed: object | null): void
{
  if (!installed)
  {
    res.status(404).json({ error: "MCP install not found", code: "MCP_INSTALL_NOT_FOUND" });
    return;
  }

  res.json(installed);
}

/**
 * Send a server response or a 404 when the server was absent.
 *
 * @param res - Express response.
 * @param server - Server payload, or null when not found.
 */
function _sendServerOrNotFound(res: Response, server: object | null): void
{
  if (!server)
  {
    res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
    return;
  }

  res.json(server);
}
