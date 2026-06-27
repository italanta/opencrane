import { GrantAccess, GrantScope, GrantSubjectType, McpCredentialBrokeringMode, McpServerStatus, McpServerTransport, type Grant, type McpServer, type McpServerCredential } from "@opencrane/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

import type { McpServerCredentialInput, McpServerGrantInput, McpServerRouteAccess, McpServerRouteScope, McpServerRouteStatus, McpServerRouteSubjectType, McpServerRouteTransport, McpServerWriteRequest } from "../../routes/mcp-servers.types.js";

type _McpServerRow = Prisma.McpServerGetPayload<{ include: { scopedGrants: true; credentials: true; source: true } }>;

/** Shared response contract returned by the MCP server routes. */
export type McpServerResponse = McpServer;

/** Shared grant contract returned for normalized MCP server grants. */
export type McpServerGrantResponse = Grant;

/** Shared credential contract returned for normalized credential rows. */
export type McpServerCredentialResponse = McpServerCredential;

/** Persist response shape returned after create/update/delete mutations. */
export interface McpServerMutationResponse
{
  /** Stable server identifier. */
  id: string;
  /** Mutation outcome label. */
  status: "created" | "updated" | "deleted";
}

/** Typed Prisma scope values used during runtime lookups. */
const _PRISMA_GRANT_SCOPE = {
  Org: "Org",
  Department: "Department",
  Team: "Team",
  Project: "Project",
  Personal: "Personal",
} as const;

/** Typed Prisma subject values used during runtime lookups. */
const _PRISMA_GRANT_SUBJECT_TYPE = {
  Group: "Group",
  Tenant: "Tenant",
  User: "User",
} as const;

/** Typed Prisma access values used during runtime lookups. */
const _PRISMA_GRANT_ACCESS = {
  Allow: "Allow",
  Deny: "Deny",
} as const;

/** Typed Prisma transport values used during runtime lookups. */
const _PRISMA_MCP_SERVER_TRANSPORT = {
  StreamableHttp: "StreamableHttp",
  ServerSentEvents: "ServerSentEvents",
  WebSocket: "WebSocket",
} as const;

/** Typed Prisma status values used during runtime lookups. */
const _PRISMA_MCP_SERVER_STATUS = {
  Active: "Active",
  Degraded: "Degraded",
  Draft: "Draft",
} as const;

/** Typed Prisma brokering-mode values used during runtime lookups. */
const _PRISMA_MCP_BROKERING_MODE = {
  StaticFallback: "StaticFallback",
  PerUserObo: "PerUserObo",
} as const;

/** Prisma brokering-mode lookup keyed by route values. */
const _PRISMA_BROKERING_BY_ROUTE = {
  static: _PRISMA_MCP_BROKERING_MODE.StaticFallback,
  obo: _PRISMA_MCP_BROKERING_MODE.PerUserObo,
};

/** Route (contract) brokering-mode lookup keyed by Prisma enum values. */
const _ROUTE_BROKERING_BY_PRISMA = {
  [_PRISMA_MCP_BROKERING_MODE.StaticFallback]: McpCredentialBrokeringMode.StaticFallback,
  [_PRISMA_MCP_BROKERING_MODE.PerUserObo]: McpCredentialBrokeringMode.PerUserObo,
};

/** Typed Prisma payload value used for MCP grants persisted in Prisma. */
const _PRISMA_MCP_SERVER_PAYLOAD_TYPE = "McpServer";

/** Route scope lookup keyed by Prisma enum values. */
const _ROUTE_SCOPE_BY_PRISMA_SCOPE = {
  [_PRISMA_GRANT_SCOPE.Org]: GrantScope.Org,
  [_PRISMA_GRANT_SCOPE.Department]: GrantScope.Department,
  [_PRISMA_GRANT_SCOPE.Team]: GrantScope.Team,
  [_PRISMA_GRANT_SCOPE.Project]: GrantScope.Project,
  [_PRISMA_GRANT_SCOPE.Personal]: GrantScope.Personal,
};

/** Prisma scope lookup keyed by route values. */
const _PRISMA_SCOPE_BY_ROUTE_SCOPE = {
  org: _PRISMA_GRANT_SCOPE.Org,
  department: _PRISMA_GRANT_SCOPE.Department,
  project: _PRISMA_GRANT_SCOPE.Project,
  personal: _PRISMA_GRANT_SCOPE.Personal,
};

/** Route subject lookup keyed by Prisma enum values. */
const _ROUTE_SUBJECT_BY_PRISMA_SUBJECT = {
  [_PRISMA_GRANT_SUBJECT_TYPE.Group]: GrantSubjectType.Group,
  [_PRISMA_GRANT_SUBJECT_TYPE.Tenant]: GrantSubjectType.Tenant,
  [_PRISMA_GRANT_SUBJECT_TYPE.User]: GrantSubjectType.User,
};

/** Prisma subject lookup keyed by route values. */
const _PRISMA_SUBJECT_BY_ROUTE_SUBJECT = {
  group: _PRISMA_GRANT_SUBJECT_TYPE.Group,
  tenant: _PRISMA_GRANT_SUBJECT_TYPE.Tenant,
  user: _PRISMA_GRANT_SUBJECT_TYPE.User,
};

/** Route access lookup keyed by Prisma enum values. */
const _ROUTE_ACCESS_BY_PRISMA_ACCESS = {
  [_PRISMA_GRANT_ACCESS.Allow]: GrantAccess.Allow,
  [_PRISMA_GRANT_ACCESS.Deny]: GrantAccess.Deny,
};

/** Prisma access lookup keyed by route values. */
const _PRISMA_ACCESS_BY_ROUTE_ACCESS = {
  allow: _PRISMA_GRANT_ACCESS.Allow,
  deny: _PRISMA_GRANT_ACCESS.Deny,
};

/** Route transport lookup keyed by Prisma enum values. */
const _ROUTE_TRANSPORT_BY_PRISMA_TRANSPORT = {
  [_PRISMA_MCP_SERVER_TRANSPORT.StreamableHttp]: McpServerTransport.StreamableHttp,
  [_PRISMA_MCP_SERVER_TRANSPORT.ServerSentEvents]: McpServerTransport.ServerSentEvents,
  [_PRISMA_MCP_SERVER_TRANSPORT.WebSocket]: McpServerTransport.WebSocket,
};

/** Prisma transport lookup keyed by route values. */
const _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT = {
  "streamable-http": _PRISMA_MCP_SERVER_TRANSPORT.StreamableHttp,
  sse: _PRISMA_MCP_SERVER_TRANSPORT.ServerSentEvents,
  websocket: _PRISMA_MCP_SERVER_TRANSPORT.WebSocket,
};

/** Route status lookup keyed by Prisma enum values. */
const _ROUTE_STATUS_BY_PRISMA_STATUS = {
  [_PRISMA_MCP_SERVER_STATUS.Active]: McpServerStatus.Active,
  [_PRISMA_MCP_SERVER_STATUS.Degraded]: McpServerStatus.Degraded,
  [_PRISMA_MCP_SERVER_STATUS.Draft]: McpServerStatus.Draft,
};

/** Prisma status lookup keyed by route values. */
const _PRISMA_STATUS_BY_ROUTE_STATUS = {
  active: _PRISMA_MCP_SERVER_STATUS.Active,
  degraded: _PRISMA_MCP_SERVER_STATUS.Degraded,
  draft: _PRISMA_MCP_SERVER_STATUS.Draft,
};

/**
 * Load every persisted MCP server with grants, credentials, and source metadata.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Normalized route response rows.
 */
export async function listMcpServers(prisma: PrismaClient): Promise<McpServerResponse[]>
{
  const servers = await prisma.mcpServer.findMany({
    orderBy: { createdAt: "desc" },
    include: { scopedGrants: true, credentials: true, source: true },
  });

  return servers.map(function _mapServer(server)
  {
    return _MapMcpServerResponse(server);
  });
}

/**
 * Load a single persisted MCP server with grants, credentials, and source metadata.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @returns Normalized response or null when the server does not exist.
 */
export async function getMcpServer(prisma: PrismaClient, serverId: string): Promise<McpServerResponse | null>
{
  const server = await prisma.mcpServer.findUnique({
    where: { id: serverId },
    include: { scopedGrants: true, credentials: true, source: true },
  });

  return server ? _MapMcpServerResponse(server) : null;
}

/**
 * Create an MCP server and its child grant and credential rows.
 *
 * @param prisma - Prisma client used for persistence.
 * @param body - Route payload provided by the caller.
 * @returns Mutation response consumed by the route.
 */
export async function createMcpServer(prisma: PrismaClient, body: McpServerWriteRequest): Promise<McpServerMutationResponse>
{
  // 1. Persist the parent server first so child grants and credentials can reference the generated identifier.
  const createdServer = await prisma.mcpServer.create({
    data: {
      name: body.name,
      description: body.description ?? "",
      endpoint: body.endpoint,
      scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope] as Prisma.McpServerCreateInput["scope"],
      transport: _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT[body.transport] as Prisma.McpServerCreateInput["transport"],
      status: _PRISMA_STATUS_BY_ROUTE_STATUS[body.status ?? "draft"] as Prisma.McpServerCreateInput["status"],
      capabilities: _NormalizeStringArray(body.capabilities),
      ...(body.sourceId ? { sourceId: body.sourceId } : {}),
      ...(body.lastSyncedAt ? { lastSyncedAt: new Date(body.lastSyncedAt) } : {}),
    },
  });

  // 2. Persist child credentials and grants after the parent exists so every row shares a stable server identifier.
  await _WriteMcpServerChildren(prisma, createdServer.id, body);

  // 3. Record an audit entry after persistence so operators can trace catalog mutations without re-reading the server table.
  await prisma.auditEntry.create({
    data: {
      action: "Created",
      resource: `McpServer/${createdServer.id}`,
      message: `MCP server ${createdServer.name} created`,
    },
  });

  return { id: createdServer.id, status: "created" };
}

/**
 * Update an MCP server and fully replace its child grant and credential rows.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @param body - Partial route payload provided by the caller.
 * @returns Mutation response consumed by the route.
 */
export async function updateMcpServer(prisma: PrismaClient, serverId: string, body: Partial<McpServerWriteRequest>): Promise<McpServerMutationResponse>
{
  // 1. Update the parent row first so the server metadata reflects the latest operator input before children are replaced.
  await prisma.mcpServer.update({
    where: { id: serverId },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? "" } : {}),
      ...(body.endpoint ? { endpoint: body.endpoint } : {}),
      ...(body.scope ? { scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope] as Prisma.McpServerUpdateInput["scope"] } : {}),
      ...(body.transport ? { transport: _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT[body.transport] as Prisma.McpServerUpdateInput["transport"] } : {}),
      ...(body.status ? { status: _PRISMA_STATUS_BY_ROUTE_STATUS[body.status] as Prisma.McpServerUpdateInput["status"] } : {}),
      ...(body.capabilities ? { capabilities: _NormalizeStringArray(body.capabilities) } : {}),
      ...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
      ...(body.lastSyncedAt !== undefined ? { lastSyncedAt: body.lastSyncedAt ? new Date(body.lastSyncedAt) : null } : {}),
    },
  });

  // 2. Replace linked credentials and grants wholesale because the submitted payload is treated as authoritative.
  await _DeleteMcpServerChildren(prisma, serverId);
  await _WriteMcpServerChildren(prisma, serverId, body);

  // 3. Record an audit entry after persistence so operators can trace the change without re-querying the server catalog.
  await prisma.auditEntry.create({
    data: {
      action: "Updated",
      resource: `McpServer/${serverId}`,
      message: `MCP server ${serverId} updated`,
    },
  });

  return { id: serverId, status: "updated" };
}

/**
 * Delete an MCP server and its child grant and credential rows.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @returns Mutation response consumed by the route.
 */
export async function deleteMcpServer(prisma: PrismaClient, serverId: string): Promise<McpServerMutationResponse>
{
  // 1. Remove child credentials and grants first so no linked rows remain once the parent server is gone.
  await _DeleteMcpServerChildren(prisma, serverId);

  // 2. Delete the parent server once the child rows have been removed.
  await prisma.mcpServer.delete({
    where: { id: serverId },
  });

  // 3. Append an audit record so destructive changes remain traceable in operator history.
  await prisma.auditEntry.create({
    data: {
      action: "Deleted",
      resource: `McpServer/${serverId}`,
      message: `MCP server ${serverId} deleted`,
    },
  });

  return { id: serverId, status: "deleted" };
}

/**
 * List the brokered credentials of a single MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @returns Credential responses, or null when the server does not exist.
 */
export async function listMcpServerCredentials(prisma: PrismaClient, serverId: string): Promise<McpServerCredentialResponse[] | null>
{
  // 1. Confirm the server exists so a missing server reads as 404, not an
  //    empty credential list (which would mask a bad identifier).
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server)
  {
    return null;
  }

  // 2. Load and normalise the credential rows for the server.
  const credentials = await prisma.mcpServerCredential.findMany({ where: { mcpServerId: serverId }, orderBy: { createdAt: "asc" } });
  return credentials.map(function _mapCredential(credential)
  {
    return _MapCredentialResponse(credential);
  });
}

/**
 * Add a single brokered credential to an MCP server without disturbing grants.
 *
 * Unlike the full PUT path (which replaces all children), this is an additive
 * mutation so operators can author one credential at a time via the CLI.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @param input - Credential payload to validate and persist.
 * @returns The created credential response, or null when the server is absent.
 * @throws {McpCredentialValidationError} When the payload breaks a custody rule.
 */
export async function addMcpServerCredential(prisma: PrismaClient, serverId: string, input: McpServerCredentialInput): Promise<McpServerCredentialResponse | null>
{
  // 1. Confirm the server exists before validating so a bad identifier reads
  //    as 404 rather than a misleading custody-validation error.
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server)
  {
    return null;
  }

  // 2. Validate the brokering-mode custody rules and build the persisted row.
  const row = _NormalizeCredentialInput(serverId, input);
  const created = await prisma.mcpServerCredential.create({ data: row });

  // 3. Record an audit entry so credential authoring stays traceable.
  await prisma.auditEntry.create({
    data: {
      action: "Created",
      resource: `McpServerCredential/${created.id}`,
      message: `MCP credential ${created.displayName} (${input.brokeringMode ?? "static"}) added to server ${serverId}`,
    },
  });

  return _MapCredentialResponse(created);
}

/**
 * Remove a single brokered credential from an MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Server identifier from the route.
 * @param credentialId - Credential identifier from the route.
 * @returns Mutation response, or null when the credential is not on the server.
 */
export async function deleteMcpServerCredential(prisma: PrismaClient, serverId: string, credentialId: string): Promise<McpServerMutationResponse | null>
{
  // 1. Scope the lookup to the owning server so a credential id from another
  //    server cannot be deleted via a mismatched path.
  const credential = await prisma.mcpServerCredential.findFirst({ where: { id: credentialId, mcpServerId: serverId }, select: { id: true } });
  if (!credential)
  {
    return null;
  }

  // 2. Delete the credential row.
  await prisma.mcpServerCredential.delete({ where: { id: credentialId } });

  // 3. Append an audit record so credential removal remains traceable.
  await prisma.auditEntry.create({
    data: {
      action: "Deleted",
      resource: `McpServerCredential/${credentialId}`,
      message: `MCP credential ${credentialId} removed from server ${serverId}`,
    },
  });

  return { id: credentialId, status: "deleted" };
}

/**
 * Raised when a credential write payload violates the brokering-mode custody
 * rules (e.g. a static credential without a secret, or an OBO credential that
 * authors a static secret). Routes translate this into a 400 response.
 */
export class McpCredentialValidationError extends Error
{
  /**
   * @param message - Human-readable explanation surfaced to the API caller.
   */
  constructor(message: string)
  {
    super(message);
    this.name = "McpCredentialValidationError";
  }
}

/**
 * Validate a credential write payload and build its Prisma createMany row.
 *
 * Enforces the P4D.1 custody rules per brokering mode: a `static` credential
 * must carry a `secretRef` (the per-tenant/per-server fallback secret), while
 * an `obo` credential must NOT — the gateway brokers a per-user RFC 8693 token,
 * so no static secret is authored centrally.
 *
 * @param serverId - Owning MCP server identifier.
 * @param credential - Raw credential payload from the route body.
 * @returns Prisma createMany input for the credential row.
 * @throws {McpCredentialValidationError} When the payload breaks a custody rule.
 */
export function _NormalizeCredentialInput(serverId: string, credential: McpServerCredentialInput): Prisma.McpServerCredentialCreateManyInput
{
  // 1. Default the mode so pre-P4D.1 payloads (no brokeringMode) stay valid.
  const routeMode = credential.brokeringMode ?? "static";

  // 2. Normalise the secret reference, treating blank strings as absent so a
  //    whitespace-only value can never masquerade as a real static secret.
  const trimmedSecret = credential.secretRef?.trim();
  const secretRef = trimmedSecret && trimmedSecret.length > 0 ? trimmedSecret : null;

  // 3. Enforce the per-mode custody invariant before persistence.
  if (routeMode === "obo" && secretRef !== null)
  {
    throw new McpCredentialValidationError(`OBO credential "${credential.displayName}" must not carry a static secretRef; Obot brokers a per-user token`);
  }

  if (routeMode === "static" && secretRef === null)
  {
    throw new McpCredentialValidationError(`static credential "${credential.displayName}" requires a non-empty secretRef`);
  }

  return {
    mcpServerId: serverId,
    displayName: credential.displayName,
    brokeringMode: _PRISMA_BROKERING_BY_ROUTE[routeMode] as Prisma.McpServerCredentialCreateManyInput["brokeringMode"],
    secretRef,
  };
}

/**
 * Write child credentials and grant rows for an MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - MCP server identifier.
 * @param body - Route payload containing grants and credentials.
 */
async function _WriteMcpServerChildren(prisma: PrismaClient, serverId: string, body: Partial<McpServerWriteRequest>): Promise<void>
{
  if (body.credentials && body.credentials.length > 0)
  {
    await prisma.mcpServerCredential.createMany({
      data: body.credentials.map(function _mapCredential(credential)
      {
        return _NormalizeCredentialInput(serverId, credential);
      }),
    });
  }

  if (!body.grants || body.grants.length === 0)
  {
    return;
  }

  const scopedGrantRows: Prisma.McpServerGrantCreateManyInput[] = [];
  for (const grant of body.grants)
  {
    const genericGrant = await prisma.grant.create({
      data: _MapGenericGrantCreateInput(serverId, grant),
    });
    scopedGrantRows.push(_MapScopedGrantCreateInput(serverId, genericGrant.id, grant));
  }

  await prisma.mcpServerGrant.createMany({
    data: scopedGrantRows,
  });
}

/**
 * Delete child credentials and grant rows for an MCP server.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - MCP server identifier.
 */
async function _DeleteMcpServerChildren(prisma: PrismaClient, serverId: string): Promise<void>
{
  await prisma.mcpServerGrant.deleteMany({ where: { mcpServerId: serverId } });
  await prisma.mcpServerCredential.deleteMany({ where: { mcpServerId: serverId } });
  await prisma.grant.deleteMany({ where: { mcpServerId: serverId, payloadType: _PRISMA_MCP_SERVER_PAYLOAD_TYPE } });
}

/**
 * Map a raw server row into the route response shape.
 *
 * @param server - Persisted server with child rows loaded.
 * @returns Normalized response payload.
 */
function _MapMcpServerResponse(server: _McpServerRow): McpServerResponse
{
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    endpoint: server.endpoint,
    scope: _ROUTE_SCOPE_BY_PRISMA_SCOPE[server.scope],
    transport: _ROUTE_TRANSPORT_BY_PRISMA_TRANSPORT[server.transport],
    status: _ROUTE_STATUS_BY_PRISMA_STATUS[server.status],
    capabilities: server.capabilities,
    sourceName: server.source?.name ?? undefined,
    lastSyncedAt: server.lastSyncedAt?.toISOString(),
    grants: server.scopedGrants.map(function _mapGrant(grant)
    {
      return {
        id: grant.id,
        scope: _ROUTE_SCOPE_BY_PRISMA_SCOPE[grant.scope],
        subjectType: _ROUTE_SUBJECT_BY_PRISMA_SUBJECT[grant.subjectType],
        subjectId: grant.subjectId,
        subjectName: grant.subjectId,
        access: _ROUTE_ACCESS_BY_PRISMA_ACCESS[grant.access],
        note: grant.note ?? undefined,
      };
    }),
    credentials: server.credentials.map(function _mapCredential(credential)
    {
      return _MapCredentialResponse(credential);
    }),
  };
}

/**
 * Map a persisted credential row into the route response shape.
 *
 * @param credential - Persisted credential row.
 * @returns Normalized credential response payload.
 */
function _MapCredentialResponse(credential: _McpServerRow["credentials"][number]): McpServerCredentialResponse
{
  return {
    id: credential.id,
    displayName: credential.displayName,
    brokeringMode: _ROUTE_BROKERING_BY_PRISMA[credential.brokeringMode],
    secretRef: credential.secretRef,
  };
}

/**
 * Normalize capability labels into a unique trimmed string array.
 *
 * @param values - Raw request values.
 * @returns Canonical capability labels.
 */
function _NormalizeStringArray(values: string[] | undefined): string[]
{
  if (!values)
  {
    return [];
  }

  const uniqueValues = new Set<string>();
  for (const value of values)
  {
    const normalizedValue = value.trim();
    if (normalizedValue.length === 0)
    {
      continue;
    }

    uniqueValues.add(normalizedValue);
  }

  return Array.from(uniqueValues);
}

/**
 * Map a route grant payload into the generic Grant table input.
 *
 * @param serverId - MCP server identifier.
 * @param grant - Route payload describing the grant.
 * @returns Prisma create input for the generic Grant table.
 */
function _MapGenericGrantCreateInput(serverId: string, grant: McpServerGrantInput): Prisma.GrantUncheckedCreateInput
{
  const subjectId = _ResolveGrantSubjectId(grant);

  return {
    payloadType: _PRISMA_MCP_SERVER_PAYLOAD_TYPE,
    payloadId: serverId,
    scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[grant.scope] as Prisma.GrantUncheckedCreateInput["scope"],
    subjectType: _PRISMA_SUBJECT_BY_ROUTE_SUBJECT[grant.subjectType] as Prisma.GrantUncheckedCreateInput["subjectType"],
    subjectId,
    access: _PRISMA_ACCESS_BY_ROUTE_ACCESS[grant.access] as Prisma.GrantUncheckedCreateInput["access"],
    priority: grant.priority ?? 0,
    note: grant.note,
    ...(grant.subjectType === "group" ? { groupId: subjectId } : {}),
    mcpServerId: serverId,
  };
}

/**
 * Map a route grant payload into the scoped MCP server grant input.
 *
 * @param serverId - MCP server identifier.
 * @param grantId - Generic grant identifier created for the same rule.
 * @param grant - Route payload describing the grant.
 * @returns Prisma createMany input for the MCP-specific grant table.
 */
function _MapScopedGrantCreateInput(serverId: string, grantId: string, grant: McpServerGrantInput): Prisma.McpServerGrantCreateManyInput
{
  const subjectId = _ResolveGrantSubjectId(grant);

  return {
    mcpServerId: serverId,
    grantId,
    scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[grant.scope] as Prisma.McpServerGrantCreateManyInput["scope"],
    subjectType: _PRISMA_SUBJECT_BY_ROUTE_SUBJECT[grant.subjectType] as Prisma.McpServerGrantCreateManyInput["subjectType"],
    subjectId,
    access: _PRISMA_ACCESS_BY_ROUTE_ACCESS[grant.access] as Prisma.McpServerGrantCreateManyInput["access"],
    priority: grant.priority ?? 0,
    note: grant.note,
    ...(grant.subjectType === "group" ? { groupId: subjectId } : {}),
  };
}

/**
 * Resolve the compiler-facing subject identifier from route input.
 *
 * @param grant - Route payload describing the grant.
 * @returns Stable subject identifier.
 */
function _ResolveGrantSubjectId(grant: McpServerGrantInput): string
{
  return grant.subjectId ?? grant.subjectName;
}
