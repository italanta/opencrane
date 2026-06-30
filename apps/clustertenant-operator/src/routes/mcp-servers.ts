import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import { McpCredentialValidationError, addMcpServerCredential, createMcpServer, deleteMcpServer, deleteMcpServerCredential, getMcpServer, listMcpServerCredentials, listMcpServers, updateMcpServer } from "../core/mcp-servers/mcp-servers.logic.js";
import { _RequireOrgAdmin } from "@opencrane/infra-auth";
import type { McpServerCredentialInput, McpServerWriteRequest } from "./mcp-servers.types.js";

/**
 * Validate the minimum MCP server create payload before it reaches Prisma.
 *
 * @param body - Untrusted route payload supplied by the caller.
 * @returns A human-readable validation error when the request is incomplete.
 */
function _validateCreateBody(body: McpServerWriteRequest): string | null
{
  if (!(typeof body.name === "string" && body.name.trim()))
  {
    return "name is required";
  }

  if (!(typeof body.endpoint === "string" && body.endpoint.trim()))
  {
    return "endpoint is required";
  }

  if (!(typeof body.scope === "string" && body.scope.trim()))
  {
    return "scope is required";
  }

  if (!(typeof body.transport === "string" && body.transport.trim()))
  {
    return "transport is required";
  }

  return null;
}

/**
 * CRUD router for the MCP server catalog.
 *
 * **Authorization (P0.5):** curating the catalogue is an org-admin action, so the
 * server lifecycle mutations (create / update / delete) are gated by `_RequireOrgAdmin`.
 * Reads stay open to any authenticated caller, and the per-server credential sub-routes
 * are intentionally NOT gated here — credential connect is a user action (spec §5.3),
 * to be designed with the P1 credential flow rather than locked to admins now.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function mcpServersRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** List all MCP servers with grants and credentials. */
  router.get("/", async function _listMcpServers(req, res)
  {
    res.json(await listMcpServers(prisma));
  });

  /** Get a single MCP server by identifier. */
  router.get("/:id", async function _getMcpServer(req, res)
  {
    const server = await getMcpServer(prisma, req.params.id);
    if (!server)
    {
      res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
      return;
    }

    res.json(server);
  });

  /** Create a new MCP server plus generic grant rows for the compiler. Org-admin only. */
  router.post("/", _RequireOrgAdmin(), async function _createMcpServer(req, res, next)
  {
    try
    {
      const body = req.body as McpServerWriteRequest;
      const validationError = _validateCreateBody(body);
      if (validationError)
      {
        res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
        return;
      }

      res.status(201).json(await createMcpServer(prisma, body));
    }
    catch (err)
    {
      // Credential custody violations (bad brokering-mode payload) are client
      // errors, not server faults — surface them as 400 rather than 500.
      if (err instanceof McpCredentialValidationError)
      {
        res.status(400).json({ error: err.message, code: "VALIDATION_ERROR" });
        return;
      }

      next(err);
    }
  });

  /** Update an MCP server and fully replace grants and credentials. Org-admin only. */
  router.put("/:id", _RequireOrgAdmin(), async function _updateMcpServer(req: Request<{ id: string }>, res, next)
  {
    try
    {
      const body = req.body as Partial<McpServerWriteRequest>;
      res.json(await updateMcpServer(prisma, req.params.id, body));
    }
    catch (err)
    {
      // See POST handler: a credential custody violation is a 400, not a 500.
      if (err instanceof McpCredentialValidationError)
      {
        res.status(400).json({ error: err.message, code: "VALIDATION_ERROR" });
        return;
      }

      next(err);
    }
  });

  /** Delete an MCP server and its linked grant rows. Org-admin only. */
  router.delete("/:id", _RequireOrgAdmin(), async function _deleteMcpServer(req: Request<{ id: string }>, res)
  {
    res.json(await deleteMcpServer(prisma, req.params.id));
  });

  /** List the brokered credentials of an MCP server. */
  router.get("/:id/credentials", async function _listMcpServerCredentials(req, res)
  {
    const credentials = await listMcpServerCredentials(prisma, req.params.id);
    if (credentials === null)
    {
      res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
      return;
    }

    res.json(credentials);
  });

  /** Add a single brokered credential to an MCP server (additive — grants untouched). */
  router.post("/:id/credentials", async function _addMcpServerCredential(req, res, next)
  {
    try
    {
      const credential = await addMcpServerCredential(prisma, req.params.id, req.body as McpServerCredentialInput);
      if (credential === null)
      {
        res.status(404).json({ error: "MCP server not found", code: "MCP_SERVER_NOT_FOUND" });
        return;
      }

      res.status(201).json(credential);
    }
    catch (err)
    {
      // A credential custody violation (bad brokering-mode payload) is a 400.
      if (err instanceof McpCredentialValidationError)
      {
        res.status(400).json({ error: err.message, code: "VALIDATION_ERROR" });
        return;
      }

      next(err);
    }
  });

  /** Remove a single brokered credential from an MCP server. */
  router.delete("/:id/credentials/:credentialId", async function _deleteMcpServerCredential(req, res)
  {
    const result = await deleteMcpServerCredential(prisma, req.params.id, req.params.credentialId);
    if (result === null)
    {
      res.status(404).json({ error: "MCP credential not found", code: "MCP_CREDENTIAL_NOT_FOUND" });
      return;
    }

    res.json(result);
  });

  return router;
}
