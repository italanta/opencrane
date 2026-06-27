import { randomBytes } from "node:crypto";

import { McpApprovalStatus, McpConnectionStatus, McpServerType, type CredentialField, type Directory, type EntitledUser, type McpAccessPolicy, type McpCatalogServer, type McpInstalled } from "@opencrane/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

import { ___SortBy } from "../../core/utils/collections.js";
import type { McpAccessPolicyRequest } from "../../routes/mcp-operator.types.js";

/** MCP server row joined with the access policy + entitled users used for filtering. */
type _McpServerWithPolicyRow = Prisma.McpServerGetPayload<{ include: { accessPolicy: { include: { users: true } } } }>;

/** Per-user install row returned by the install/connect mutations. */
type _McpInstallRow = Prisma.McpServerInstallGetPayload<object>;

/**
 * Identity + entitlement context of the caller of a user-facing endpoint.
 *
 * `devOpen` mirrors the platform's fail-open dev posture: when no session is
 * established and no real auth is configured, the caller sees the full published
 * catalogue so a fresh local install / the OPEN dev backend isn't locked out.
 */
export interface McpOperatorCaller
{
  /** Stable caller identifier (`authUser.sub ?? authUser.email`, or a dev fallback). */
  userId: string;
  /** IdP-verified group claims used for group-based entitlement. */
  groups: string[];
  /** True only when unauthenticated under dev-auth-mode — bypasses entitlement filtering. */
  devOpen: boolean;
}

/** Typed Prisma `McpServerType` values (member names, not the @map'd DB labels). */
const _PRISMA_SERVER_TYPE = {
  SingleUser: "SingleUser",
  MultiUser: "MultiUser",
  RemoteOauth: "RemoteOauth",
} as const;

/** Typed Prisma `McpApprovalStatus` values used during runtime lookups. */
const _PRISMA_APPROVAL_STATUS = {
  PendingReview: "PendingReview",
  Approved: "Approved",
  Published: "Published",
  Disabled: "Disabled",
} as const;

/** Typed Prisma `McpConnectionStatus` values used during runtime lookups. */
const _PRISMA_CONNECTION_STATUS = {
  NeedsCredential: "NeedsCredential",
  Activating: "Activating",
  Connected: "Connected",
  OauthConnected: "OauthConnected",
  SharedKey: "SharedKey",
  ActivationFailed: "ActivationFailed",
} as const;

/** Contract server-type lookup keyed by Prisma enum values. */
const _TYPE_BY_PRISMA = {
  [_PRISMA_SERVER_TYPE.SingleUser]: McpServerType.SingleUser,
  [_PRISMA_SERVER_TYPE.MultiUser]: McpServerType.MultiUser,
  [_PRISMA_SERVER_TYPE.RemoteOauth]: McpServerType.RemoteOauth,
};

/** Contract approval-status lookup keyed by Prisma enum values. */
const _APPROVAL_BY_PRISMA = {
  [_PRISMA_APPROVAL_STATUS.PendingReview]: McpApprovalStatus.PendingReview,
  [_PRISMA_APPROVAL_STATUS.Approved]: McpApprovalStatus.Approved,
  [_PRISMA_APPROVAL_STATUS.Published]: McpApprovalStatus.Published,
  [_PRISMA_APPROVAL_STATUS.Disabled]: McpApprovalStatus.Disabled,
};

/** Contract connection-status lookup keyed by Prisma enum values. */
const _CONNECTION_BY_PRISMA = {
  [_PRISMA_CONNECTION_STATUS.NeedsCredential]: McpConnectionStatus.NeedsCredential,
  [_PRISMA_CONNECTION_STATUS.Activating]: McpConnectionStatus.Activating,
  [_PRISMA_CONNECTION_STATUS.Connected]: McpConnectionStatus.Connected,
  [_PRISMA_CONNECTION_STATUS.OauthConnected]: McpConnectionStatus.OauthConnected,
  [_PRISMA_CONNECTION_STATUS.SharedKey]: McpConnectionStatus.SharedKey,
  [_PRISMA_CONNECTION_STATUS.ActivationFailed]: McpConnectionStatus.ActivationFailed,
};

/** Deterministic avatar palette indexed by a stable hash of the user identifier. */
const _AVATAR_COLORS = ["#1F3B6E", "#2E7D32", "#6A1B9A", "#C62828", "#00838F", "#EF6C00", "#4527A0", "#283593"];

/**
 * List the catalogue servers the caller may see: published AND entitled.
 *
 * @param prisma - Prisma client used for persistence.
 * @param caller - Identity + entitlement context of the calling user.
 * @returns Published, entitlement-scoped catalogue rows.
 */
export async function listEntitledCatalog(prisma: PrismaClient, caller: McpOperatorCaller): Promise<McpCatalogServer[]>
{
  // 1. Narrow to published servers in the database so disabled/pending rows never
  //    leave the governance boundary, then load each server's access policy.
  const servers = await prisma.mcpServer.findMany({
    where: { approvalStatus: _PRISMA_APPROVAL_STATUS.Published as Prisma.McpServerWhereInput["approvalStatus"] },
    include: { accessPolicy: { include: { users: true } } },
    orderBy: { createdAt: "desc" },
  });

  // 2. Apply the per-caller entitlement filter (everyone-in-org / user / group),
  //    bypassed only under the dev-open posture, then map to the wire shape.
  return servers
    .filter(function _entitled(server) { return _IsEntitled(server, caller); })
    .map(function _map(server) { return _MapCatalogServer(server); });
}

/**
 * List every catalogue server regardless of status — the org-admin governance view.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns All catalogue rows in newest-first order.
 */
export async function listAllServers(prisma: PrismaClient): Promise<McpCatalogServer[]>
{
  const servers = await prisma.mcpServer.findMany({ orderBy: { createdAt: "desc" } });
  return servers.map(function _map(server) { return _MapCatalogServer(server); });
}

/**
 * List the servers the calling user has installed.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @returns The caller's install rows in wire shape.
 */
export async function listInstalled(prisma: PrismaClient, userId: string): Promise<McpInstalled[]>
{
  const installs = await prisma.mcpServerInstall.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return installs.map(function _map(install) { return _MapInstalled(install); });
}

/**
 * Install a catalogue server for the calling user (idempotent per user+server).
 *
 * The initial connection state is derived from the server type: a multi-user
 * server is satisfied by the org-wide shared key immediately (`shared-key`),
 * while every other type starts out needing a per-user credential.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Catalogue server identifier to install.
 * @returns The install row, or null when the server does not exist.
 */
export async function installServer(prisma: PrismaClient, userId: string, serverId: string): Promise<McpInstalled | null>
{
  // 1. Confirm the server exists so a bad identifier reads as 404 rather than a
  //    dangling install row pointing at nothing.
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { serverType: true } });
  if (!server)
  {
    return null;
  }

  // 2. Multi-user servers are brokered by an org-wide shared key, so the install
  //    is connected on creation; every other type must author a credential first.
  const initialStatus = server.serverType === _PRISMA_SERVER_TYPE.MultiUser
    ? _PRISMA_CONNECTION_STATUS.SharedKey
    : _PRISMA_CONNECTION_STATUS.NeedsCredential;

  // 3. Upsert so a repeated install is idempotent and never duplicates the row,
  //    leaving an already-connected install untouched.
  const install = await prisma.mcpServerInstall.upsert({
    where: { mcpServerId_userId: { mcpServerId: serverId, userId } },
    create: { mcpServerId: serverId, userId, connectionStatus: initialStatus as Prisma.McpServerInstallCreateInput["connectionStatus"] },
    update: {},
  });

  await _AuditInstall(prisma, "Created", serverId, userId, `MCP server ${serverId} installed for ${userId}`);
  return _MapInstalled(install);
}

/**
 * Uninstall a server for the calling user, clearing any stored credential handle.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @returns True when an install was removed, false when none existed.
 */
export async function uninstallServer(prisma: PrismaClient, userId: string, serverId: string): Promise<boolean>
{
  // 1. Scope the delete to the caller's own install so one user cannot uninstall
  //    another's; a missing row reads as a no-op 404 at the route.
  const result = await prisma.mcpServerInstall.deleteMany({ where: { mcpServerId: serverId, userId } });
  if (result.count === 0)
  {
    return false;
  }

  // 2. Deleting the row drops the credentialRef custody handle with it, so no
  //    further brokering can occur for this user+server.
  await _AuditInstall(prisma, "Deleted", serverId, userId, `MCP server ${serverId} uninstalled for ${userId}`);
  return true;
}

/**
 * Store a per-user credential (WRITE-ONLY) and mark the install connected.
 *
 * The submitted `values` are never persisted as plaintext and never returned: a
 * minted opaque `credentialRef` is the only thing kept, standing in for the secret
 * the gateway plane (Obot) brokers. No response serialises credential material.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @returns The updated install row, or null when no install exists for the caller.
 */
export async function setCredential(prisma: PrismaClient, userId: string, serverId: string): Promise<McpInstalled | null>
{
  // 1. Require an existing install so credential authoring follows install; a
  //    missing install reads as 404 rather than silently creating one.
  const existing = await prisma.mcpServerInstall.findUnique({ where: { mcpServerId_userId: { mcpServerId: serverId, userId } }, select: { id: true } });
  if (!existing)
  {
    return null;
  }

  // 2. Mint an opaque custody handle; the raw values are discarded here and the
  //    secret is brokered by the gateway plane, so nothing secret touches the DB.
  const credentialRef = `cred_${randomBytes(18).toString("hex")}`;

  // 3. Flip the install to connected and attach the handle.
  const install = await prisma.mcpServerInstall.update({
    where: { mcpServerId_userId: { mcpServerId: serverId, userId } },
    data: { credentialRef, connectionStatus: _PRISMA_CONNECTION_STATUS.Connected as Prisma.McpServerInstallUpdateInput["connectionStatus"] },
  });

  await _AuditInstall(prisma, "Updated", serverId, userId, `MCP credential connected for ${userId} on server ${serverId}`);
  return _MapInstalled(install);
}

/**
 * Clear a per-user credential, returning the install to `needs-credential`.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @returns The updated install row, or null when no install exists for the caller.
 */
export async function clearCredential(prisma: PrismaClient, userId: string, serverId: string): Promise<McpInstalled | null>
{
  return _TransitionInstall(prisma, userId, serverId, _PRISMA_CONNECTION_STATUS.NeedsCredential, true, `MCP credential cleared for ${userId} on server ${serverId}`);
}

/**
 * Mark a remote-OAuth install connected after a successful OAuth handshake.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @returns The updated install row, or null when no install exists for the caller.
 */
export async function connectOauth(prisma: PrismaClient, userId: string, serverId: string): Promise<McpInstalled | null>
{
  // 1. Require an existing install so the OAuth callback targets a real row.
  const existing = await prisma.mcpServerInstall.findUnique({ where: { mcpServerId_userId: { mcpServerId: serverId, userId } }, select: { id: true } });
  if (!existing)
  {
    return null;
  }

  // 2. Mint a custody handle for the brokered OAuth grant and flip to connected;
  //    the grant material lives in the gateway plane, not here.
  const credentialRef = `oauth_${randomBytes(18).toString("hex")}`;
  const install = await prisma.mcpServerInstall.update({
    where: { mcpServerId_userId: { mcpServerId: serverId, userId } },
    data: { credentialRef, connectionStatus: _PRISMA_CONNECTION_STATUS.OauthConnected as Prisma.McpServerInstallUpdateInput["connectionStatus"] },
  });

  await _AuditInstall(prisma, "Updated", serverId, userId, `MCP OAuth connected for ${userId} on server ${serverId}`);
  return _MapInstalled(install);
}

/**
 * Disconnect a remote-OAuth install, returning it to `needs-credential`.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @returns The updated install row, or null when no install exists for the caller.
 */
export async function disconnectOauth(prisma: PrismaClient, userId: string, serverId: string): Promise<McpInstalled | null>
{
  return _TransitionInstall(prisma, userId, serverId, _PRISMA_CONNECTION_STATUS.NeedsCredential, true, `MCP OAuth disconnected for ${userId} on server ${serverId}`);
}

/**
 * Move a server through the governance lifecycle by setting its approval status.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @param target - The Prisma approval-status value to set.
 * @param message - Audit message describing the transition.
 * @returns The updated server in wire shape, or null when it does not exist.
 */
async function _SetApprovalStatus(prisma: PrismaClient, serverId: string, target: string, message: string): Promise<McpCatalogServer | null>
{
  // 1. Confirm the server exists so a bad identifier reads as 404, not a write.
  const existing = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!existing)
  {
    return null;
  }

  // 2. Set the target status and record an audit entry so governance decisions
  //    stay traceable in operator history.
  const server = await prisma.mcpServer.update({
    where: { id: serverId },
    data: { approvalStatus: target as Prisma.McpServerUpdateInput["approvalStatus"] },
  });
  await prisma.auditEntry.create({ data: { action: "Updated", resource: `McpServer/${serverId}`, message } });

  return _MapCatalogServer(server);
}

/**
 * Approve a server (pending-review → approved).
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @returns The updated server, or null when it does not exist.
 */
export async function approveServer(prisma: PrismaClient, serverId: string): Promise<McpCatalogServer | null>
{
  return _SetApprovalStatus(prisma, serverId, _PRISMA_APPROVAL_STATUS.Approved, `MCP server ${serverId} approved`);
}

/**
 * Publish a server (approved → published) so entitled callers can install it.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @returns The updated server, or null when it does not exist.
 */
export async function publishServer(prisma: PrismaClient, serverId: string): Promise<McpCatalogServer | null>
{
  return _SetApprovalStatus(prisma, serverId, _PRISMA_APPROVAL_STATUS.Published, `MCP server ${serverId} published`);
}

/**
 * Reject a server (→ disabled), removing it from the user-facing catalogue.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @returns The updated server, or null when it does not exist.
 */
export async function rejectServer(prisma: PrismaClient, serverId: string): Promise<McpCatalogServer | null>
{
  return _SetApprovalStatus(prisma, serverId, _PRISMA_APPROVAL_STATUS.Disabled, `MCP server ${serverId} rejected`);
}

/**
 * Toggle a server's availability (true → published, false → disabled).
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @param enabled - True publishes; false disables.
 * @returns The updated server, or null when it does not exist.
 */
export async function setServerEnabled(prisma: PrismaClient, serverId: string, enabled: boolean): Promise<McpCatalogServer | null>
{
  const target = enabled ? _PRISMA_APPROVAL_STATUS.Published : _PRISMA_APPROVAL_STATUS.Disabled;
  return _SetApprovalStatus(prisma, serverId, target, `MCP server ${serverId} ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Read a server's access policy, projecting entitled users into the wire shape.
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @returns The access policy (defaults when none is authored), or null when the server is absent.
 */
export async function getAccessPolicy(prisma: PrismaClient, serverId: string): Promise<McpAccessPolicy | null>
{
  // 1. Confirm the server exists so a bad identifier reads as 404, not an empty policy.
  const server = await prisma.mcpServer.findUnique({
    where: { id: serverId },
    include: { accessPolicy: { include: { users: true } } },
  });
  if (!server)
  {
    return null;
  }

  // 2. Project the persisted policy (or empty defaults) into the wire shape.
  return _MapAccessPolicy(serverId, server.accessPolicy);
}

/**
 * Replace a server's access policy wholesale (admin authoritative write).
 *
 * @param prisma - Prisma client used for persistence.
 * @param serverId - Catalogue server identifier.
 * @param body - Full replacement policy (everyoneInOrg + group ids + user ids).
 * @returns The persisted policy in wire shape, or null when the server is absent.
 */
export async function setAccessPolicy(prisma: PrismaClient, serverId: string, body: McpAccessPolicyRequest): Promise<McpAccessPolicy | null>
{
  // 1. Confirm the server exists before authoring a policy against it.
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server)
  {
    return null;
  }

  // 2. Normalise the submitted ids so blank/duplicate entries cannot inflate the
  //    entitlement lists.
  const groups = _NormalizeIds(body.groups);
  const userIds = _NormalizeIds(body.users);

  // 3. Upsert the policy parent, then replace its user rows wholesale because the
  //    submitted payload is treated as authoritative.
  const policy = await prisma.mcpServerAccessPolicy.upsert({
    where: { mcpServerId: serverId },
    create: { mcpServerId: serverId, everyoneInOrg: body.everyoneInOrg, groups },
    update: { everyoneInOrg: body.everyoneInOrg, groups },
  });
  await prisma.mcpServerAccessUser.deleteMany({ where: { accessPolicyId: policy.id } });
  if (userIds.length > 0)
  {
    await prisma.mcpServerAccessUser.createMany({
      data: userIds.map(function _row(userId) { return { accessPolicyId: policy.id, userId }; }),
    });
  }

  // 4. Record an audit entry so access changes stay traceable.
  await prisma.auditEntry.create({ data: { action: "Updated", resource: `McpServer/${serverId}`, message: `MCP server ${serverId} access policy updated` } });

  return _MapAccessPolicy(serverId, { everyoneInOrg: body.everyoneInOrg, groups, users: userIds.map(function _u(userId) { return { userId }; }) });
}

/**
 * Build the selectable universe of users and groups for the admin access editor.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Distinct entitled users plus all group names.
 */
export async function getDirectory(prisma: PrismaClient): Promise<Directory>
{
  // 1. Load every group (for its name) and its JSON membership list.
  const groups = await prisma.group.findMany({ orderBy: { name: "asc" }, select: { name: true, members: true } });

  // 2. Also fold in any user already entitled via an access policy so directly
  //    granted users remain selectable even if not in a group.
  const accessUsers = await prisma.mcpServerAccessUser.findMany({ select: { userId: true } });

  // 3. Collect distinct principal identifiers from both sources.
  const userIds = new Set<string>();
  for (const group of groups)
  {
    for (const member of _NormalizeMembers(group.members))
    {
      userIds.add(member);
    }
  }
  for (const accessUser of accessUsers)
  {
    userIds.add(accessUser.userId);
  }

  return {
    users: ___SortBy(Array.from(userIds)).map(function _u(userId) { return _MapEntitledUser(userId); }),
    groups: groups.map(function _g(group) { return group.name; }),
  };
}

/**
 * Resolve a per-mode install transition, optionally clearing the credential handle.
 *
 * @param prisma - Prisma client used for persistence.
 * @param userId - Stable caller identifier.
 * @param serverId - Installed server identifier.
 * @param status - Target Prisma connection-status value.
 * @param clearRef - When true, the credentialRef custody handle is dropped.
 * @param message - Audit message describing the transition.
 * @returns The updated install row, or null when no install exists for the caller.
 */
async function _TransitionInstall(prisma: PrismaClient, userId: string, serverId: string, status: string, clearRef: boolean, message: string): Promise<McpInstalled | null>
{
  // 1. Require an existing install so the transition targets a real row.
  const existing = await prisma.mcpServerInstall.findUnique({ where: { mcpServerId_userId: { mcpServerId: serverId, userId } }, select: { id: true } });
  if (!existing)
  {
    return null;
  }

  // 2. Apply the status change, dropping the custody handle when the connection
  //    is being torn down so no stale broker reference survives.
  const install = await prisma.mcpServerInstall.update({
    where: { mcpServerId_userId: { mcpServerId: serverId, userId } },
    data: { connectionStatus: status as Prisma.McpServerInstallUpdateInput["connectionStatus"], ...(clearRef ? { credentialRef: null } : {}) },
  });

  await _AuditInstall(prisma, "Updated", serverId, userId, message);
  return _MapInstalled(install);
}

/**
 * Append an audit entry for a per-user install mutation.
 *
 * @param prisma - Prisma client used for persistence.
 * @param action - Audit action label.
 * @param serverId - Installed server identifier.
 * @param userId - Stable caller identifier.
 * @param message - Human-readable audit message.
 */
async function _AuditInstall(prisma: PrismaClient, action: string, serverId: string, userId: string, message: string): Promise<void>
{
  await prisma.auditEntry.create({ data: { action, resource: `McpServerInstall/${serverId}:${userId}`, message } });
}

/**
 * Decide whether a caller is entitled to a published server.
 *
 * @param server - Server row with its access policy + entitled users loaded.
 * @param caller - Identity + entitlement context of the calling user.
 * @returns True when the caller may see / install the server.
 */
function _IsEntitled(server: _McpServerWithPolicyRow, caller: McpOperatorCaller): boolean
{
  // 1. Dev-open posture bypasses entitlement so a local install isn't locked out.
  if (caller.devOpen)
  {
    return true;
  }

  // 2. No policy authored → fail closed; an admin must grant access explicitly.
  const policy = server.accessPolicy;
  if (!policy)
  {
    return false;
  }

  // 3. Org-wide grant short-circuits the per-user / per-group lists.
  if (policy.everyoneInOrg)
  {
    return true;
  }

  // 4. Direct user grant, then group-claim intersection.
  if (policy.users.some(function _u(user) { return user.userId === caller.userId; }))
  {
    return true;
  }

  return policy.groups.some(function _g(group) { return caller.groups.includes(group); });
}

/**
 * Map a server row into the operator catalogue wire shape.
 *
 * @param server - Persisted server row.
 * @returns Normalized catalogue server payload.
 */
function _MapCatalogServer(server: Prisma.McpServerGetPayload<object>): McpCatalogServer
{
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    publisher: server.publisher ?? undefined,
    glyph: server.glyph ?? undefined,
    type: _TYPE_BY_PRISMA[server.serverType],
    approvalStatus: _APPROVAL_BY_PRISMA[server.approvalStatus],
    credentialSchema: _NormalizeCredentialSchema(server.credentialSchema),
    entitlementSummary: server.entitlementSummary ?? undefined,
  };
}

/**
 * Map a per-user install row into the operator wire shape.
 *
 * Deliberately omits `credentialRef`: the custody handle is never serialised.
 *
 * @param install - Persisted install row.
 * @returns Normalized install payload.
 */
function _MapInstalled(install: _McpInstallRow): McpInstalled
{
  return {
    serverId: install.mcpServerId,
    connectionStatus: _CONNECTION_BY_PRISMA[install.connectionStatus],
    lastUsed: install.lastUsedAt ? install.lastUsedAt.toISOString() : null,
    connectedAccount: install.connectedAccount ?? undefined,
  };
}

/**
 * Project an access policy (or empty defaults) into the wire shape.
 *
 * @param serverId - Governed server identifier.
 * @param policy - Persisted policy with entitled users, or null/partial.
 * @returns Normalized access-policy payload.
 */
function _MapAccessPolicy(serverId: string, policy: { everyoneInOrg: boolean; groups: string[]; users: { userId: string }[] } | null): McpAccessPolicy
{
  return {
    serverId,
    everyoneInOrg: policy?.everyoneInOrg ?? false,
    groups: policy?.groups ?? [],
    users: (policy?.users ?? []).map(function _u(user) { return _MapEntitledUser(user.userId); }),
  };
}

/**
 * Derive an EntitledUser display projection from a stable identifier.
 *
 * @param userId - Stable principal identifier (sub or email).
 * @returns Display name, initials, and a deterministic avatar colour.
 */
function _MapEntitledUser(userId: string): EntitledUser
{
  // 1. Prefer the local-part of an email for the display name; fall back to the id.
  const localPart = userId.includes("@") ? userId.slice(0, userId.indexOf("@")) : userId;
  const name = localPart.length > 0 ? localPart : userId;

  // 2. Build two-letter initials from word boundaries in the name.
  const words = name.split(/[\s._-]+/).filter(function _nonEmpty(word) { return word.length > 0; });
  const initials = (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase();

  // 3. Pick a stable palette colour from a simple checksum of the identifier.
  let checksum = 0;
  for (let index = 0; index < userId.length; index += 1)
  {
    checksum = (checksum + userId.charCodeAt(index)) % _AVATAR_COLORS.length;
  }

  return { id: userId, name, initials, color: _AVATAR_COLORS[checksum] };
}

/**
 * Parse the persisted credential-schema JSON into typed fields.
 *
 * @param value - Raw JSON value from the server row.
 * @returns Credential fields, or an empty array when the value is malformed.
 */
function _NormalizeCredentialSchema(value: Prisma.JsonValue): CredentialField[]
{
  if (!Array.isArray(value))
  {
    return [];
  }

  const fields: CredentialField[] = [];
  for (const entry of value)
  {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    {
      continue;
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || typeof record.label !== "string")
    {
      continue;
    }

    fields.push({
      key: record.key,
      label: record.label,
      required: record.required === true,
      sensitive: record.sensitive === true,
      ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
      ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
    });
  }

  return fields;
}

/**
 * Normalize a list of identifiers: trim, drop blanks, de-duplicate, sort.
 *
 * @param values - Raw identifier list from a request body.
 * @returns Canonical identifier list.
 */
function _NormalizeIds(values: string[] | undefined): string[]
{
  if (!Array.isArray(values))
  {
    return [];
  }

  const unique = new Set<string>();
  for (const value of values)
  {
    if (typeof value !== "string")
    {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0)
    {
      unique.add(trimmed);
    }
  }

  return ___SortBy(Array.from(unique));
}

/**
 * Normalize a group's JSON membership list into trimmed principal identifiers.
 *
 * @param members - Raw JSON value from the group row.
 * @returns Distinct, sorted principal identifiers.
 */
function _NormalizeMembers(members: Prisma.JsonValue): string[]
{
  if (!Array.isArray(members))
  {
    return [];
  }

  const unique = new Set<string>();
  for (const member of members)
  {
    if (typeof member !== "string")
    {
      continue;
    }

    const trimmed = member.trim();
    if (trimmed.length > 0)
    {
      unique.add(trimmed);
    }
  }

  return Array.from(unique);
}
