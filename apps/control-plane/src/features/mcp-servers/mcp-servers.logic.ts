import {
  GrantAccess as __PrismaGrantAccess,
  GrantPayloadType as __PrismaGrantPayloadType,
  GrantScope as __PrismaGrantScope,
  GrantSubjectType as __PrismaGrantSubjectType,
  McpServerStatus as __PrismaMcpServerStatus,
  McpServerTransport as __PrismaMcpServerTransport,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { uniq as ___uniq } from "lodash";

import type {
  McpServerGrantInput,
  McpServerRouteAccess,
  McpServerRouteScope,
  McpServerRouteStatus,
  McpServerRouteSubjectType,
  McpServerRouteTransport,
  McpServerWriteRequest,
} from "../../routes/mcp-servers.types.js";

type _McpServerRow = Prisma.McpServerGetPayload<{ include: { scopedGrants: true; credentials: true; source: true } }>;

/** JSON response shape returned by the MCP server routes. */
export interface McpServerResponse
{
  /** Stable server identifier. */
  id: string;
  /** Display name shown in the catalog. */
  name: string;
  /** Operator-facing summary. */
  description: string;
  /** Gateway endpoint or upstream address. */
  endpoint: string;
  /** Primary organizational scope for the server. */
  scope: McpServerRouteScope;
  /** Transport contract used by the server. */
  transport: McpServerRouteTransport;
  /** Current rollout status. */
  status: McpServerRouteStatus;
  /** Capability labels surfaced in the UI. */
  capabilities: string[];
  /** Optional upstream source label. */
  sourceName?: string;
  /** Last successful sync timestamp. */
  lastSyncedAt?: string;
  /** Compiled grants linked to the server. */
  grants: McpServerGrantResponse[];
  /** Credential metadata linked to the server. */
  credentials: McpServerCredentialResponse[];
}

/** JSON response shape returned for a normalized MCP server grant. */
export interface McpServerGrantResponse
{
  /** Stable grant identifier. */
  id: string;
  /** Organizational scope carried by the grant. */
  scope: McpServerRouteScope;
  /** Subject family receiving the grant. */
  subjectType: McpServerRouteSubjectType;
  /** Subject identifier used by the compiler. */
  subjectId: string;
  /** Human-friendly subject label. */
  subjectName: string;
  /** Allow or deny outcome. */
  access: McpServerRouteAccess;
  /** Optional operator note. */
  note?: string;
}

/** JSON response shape returned for a normalized credential row. */
export interface McpServerCredentialResponse
{
  /** Stable credential identifier. */
  id: string;
  /** Operator-facing label for the credential. */
  displayName: string;
  /** Secret reference consumed by the gateway. */
  secretRef: string;
}

/** Persist response shape returned after create/update/delete mutations. */
export interface McpServerMutationResponse
{
  /** Stable server identifier. */
  id: string;
  /** Mutation outcome label. */
  status: "created" | "updated" | "deleted";
}

/** Route scope lookup keyed by Prisma enum values. */
const _ROUTE_SCOPE_BY_PRISMA_SCOPE: Record<__PrismaGrantScope, McpServerRouteScope> = {
  [__PrismaGrantScope.Org]: "org",
  [__PrismaGrantScope.Department]: "department",
  [__PrismaGrantScope.Project]: "project",
  [__PrismaGrantScope.Personal]: "personal",
};

/** Prisma scope lookup keyed by route values. */
const _PRISMA_SCOPE_BY_ROUTE_SCOPE: Record<McpServerRouteScope, __PrismaGrantScope> = {
  org: __PrismaGrantScope.Org,
  department: __PrismaGrantScope.Department,
  project: __PrismaGrantScope.Project,
  personal: __PrismaGrantScope.Personal,
};

/** Route subject lookup keyed by Prisma enum values. */
const _ROUTE_SUBJECT_BY_PRISMA_SUBJECT: Record<__PrismaGrantSubjectType, McpServerRouteSubjectType> = {
  [__PrismaGrantSubjectType.Group]: "group",
  [__PrismaGrantSubjectType.Tenant]: "tenant",
  [__PrismaGrantSubjectType.User]: "user",
};

/** Prisma subject lookup keyed by route values. */
const _PRISMA_SUBJECT_BY_ROUTE_SUBJECT: Record<McpServerRouteSubjectType, __PrismaGrantSubjectType> = {
  group: __PrismaGrantSubjectType.Group,
  tenant: __PrismaGrantSubjectType.Tenant,
  user: __PrismaGrantSubjectType.User,
};

/** Route access lookup keyed by Prisma enum values. */
const _ROUTE_ACCESS_BY_PRISMA_ACCESS: Record<__PrismaGrantAccess, McpServerRouteAccess> = {
  [__PrismaGrantAccess.Allow]: "allow",
  [__PrismaGrantAccess.Deny]: "deny",
};

/** Prisma access lookup keyed by route values. */
const _PRISMA_ACCESS_BY_ROUTE_ACCESS: Record<McpServerRouteAccess, __PrismaGrantAccess> = {
  allow: __PrismaGrantAccess.Allow,
  deny: __PrismaGrantAccess.Deny,
};

/** Route transport lookup keyed by Prisma enum values. */
const _ROUTE_TRANSPORT_BY_PRISMA_TRANSPORT: Record<__PrismaMcpServerTransport, McpServerRouteTransport> = {
  [__PrismaMcpServerTransport.StreamableHttp]: "streamable-http",
  [__PrismaMcpServerTransport.ServerSentEvents]: "sse",
  [__PrismaMcpServerTransport.WebSocket]: "websocket",
};

/** Prisma transport lookup keyed by route values. */
const _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT: Record<McpServerRouteTransport, __PrismaMcpServerTransport> = {
  "streamable-http": __PrismaMcpServerTransport.StreamableHttp,
  sse: __PrismaMcpServerTransport.ServerSentEvents,
  websocket: __PrismaMcpServerTransport.WebSocket,
};

/** Route status lookup keyed by Prisma enum values. */
const _ROUTE_STATUS_BY_PRISMA_STATUS: Record<__PrismaMcpServerStatus, McpServerRouteStatus> = {
  [__PrismaMcpServerStatus.Active]: "active",
  [__PrismaMcpServerStatus.Degraded]: "degraded",
  [__PrismaMcpServerStatus.Draft]: "draft",
};

/** Prisma status lookup keyed by route values. */
const _PRISMA_STATUS_BY_ROUTE_STATUS: Record<McpServerRouteStatus, __PrismaMcpServerStatus> = {
  active: __PrismaMcpServerStatus.Active,
  degraded: __PrismaMcpServerStatus.Degraded,
  draft: __PrismaMcpServerStatus.Draft,
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
      scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope],
      transport: _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT[body.transport],
      status: _PRISMA_STATUS_BY_ROUTE_STATUS[body.status ?? "draft"],
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
      ...(body.scope ? { scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope] } : {}),
      ...(body.transport ? { transport: _PRISMA_TRANSPORT_BY_ROUTE_TRANSPORT[body.transport] } : {}),
      ...(body.status ? { status: _PRISMA_STATUS_BY_ROUTE_STATUS[body.status] } : {}),
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
        return {
          mcpServerId: serverId,
          displayName: credential.displayName,
          secretRef: credential.secretRef,
        };
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
  await prisma.grant.deleteMany({ where: { mcpServerId: serverId, payloadType: __PrismaGrantPayloadType.McpServer } });
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
      return {
        id: credential.id,
        displayName: credential.displayName,
        secretRef: credential.secretRef,
      };
    }),
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

  return ___uniq(values.map(function _trim(value)
  {
    return value.trim();
  }).filter(function _isNonEmpty(value)
  {
    return value.length > 0;
  }));
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
    payloadType: __PrismaGrantPayloadType.McpServer,
    payloadId: serverId,
    scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[grant.scope],
    subjectType: _PRISMA_SUBJECT_BY_ROUTE_SUBJECT[grant.subjectType],
    subjectId,
    access: _PRISMA_ACCESS_BY_ROUTE_ACCESS[grant.access],
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
    scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[grant.scope],
    subjectType: _PRISMA_SUBJECT_BY_ROUTE_SUBJECT[grant.subjectType],
    subjectId,
    access: _PRISMA_ACCESS_BY_ROUTE_ACCESS[grant.access],
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
