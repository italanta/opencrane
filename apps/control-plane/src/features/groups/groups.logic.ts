import { GrantAccess, GrantScope, GrantSubjectType, type Grant, type Group } from "@opencrane/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ___SortBy } from "../../core/utils/collections.js";

import type {
  GroupGrantInput,
  GroupRouteAccess,
  GroupRouteScope,
  GroupRouteSubjectType,
  GroupWriteRequest,
} from "../../routes/groups.types.js";

type _GroupWithGrantsRow = Prisma.GroupGetPayload<{ include: { grants: true } }>;

/** Shared response contract returned by the groups routes. */
export type GroupResponse = Group;

/** Shared grant contract returned for normalized group grants. */
export type GroupGrantResponse = Grant;

/** Persist response shape returned after create/update/delete mutations. */
export interface GroupMutationResponse
{
  /** Stable group identifier. */
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

/** Typed Prisma payload value used for awareness grants persisted in Prisma. */
const _PRISMA_AWARENESS_PAYLOAD_TYPE = "Awareness";

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

/**
 * Load every persisted group with its attached awareness grants.
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Normalized route response rows.
 */
export async function listGroups(prisma: PrismaClient): Promise<GroupResponse[]>
{
  const groups = await prisma.group.findMany({
    orderBy: { createdAt: "desc" },
    include: { grants: true },
  });

  return groups.map(function _mapGroup(group)
  {
    return _MapGroupResponse(group);
  });
}

/**
 * Load a single persisted group with attached awareness grants.
 *
 * @param prisma - Prisma client used for persistence.
 * @param groupId - Group identifier from the route.
 * @returns Normalized response or null when the group does not exist.
 */
export async function getGroup(prisma: PrismaClient, groupId: string): Promise<GroupResponse | null>
{
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { grants: true },
  });

  return group ? _MapGroupResponse(group) : null;
}

/**
 * Create a group and any default awareness grants linked to it.
 *
 * @param prisma - Prisma client used for persistence.
 * @param body - Route payload provided by the caller.
 * @returns Mutation response consumed by the route.
 */
export async function createGroup(prisma: PrismaClient, body: GroupWriteRequest): Promise<GroupMutationResponse>
{
  // 1. Normalize membership input first so persistence and response payloads use the same canonical principal list.
  const members = _NormalizeMembers(body.members);

  // 2. Persist the group before grants so every linked grant can reference the generated group identifier.
  const createdGroup = await prisma.group.create({
    data: {
      name: body.name,
      scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope] as Prisma.GroupCreateInput["scope"],
      ...(body.description ? { description: body.description } : {}),
      members: members as Prisma.InputJsonValue,
    },
  });

  // 3. Persist any attached awareness grants because they are evaluated alongside direct tenant and user grants.
  if (body.grants && body.grants.length > 0)
  {
    await prisma.grant.createMany({
      data: body.grants.map(function _mapGrant(grant)
      {
        return _MapGrantCreateInput(createdGroup.id, grant);
      }),
    });
  }

  // 4. Write an audit entry after persistence so operators can trace catalog mutations without re-reading the group table.
  await prisma.auditEntry.create({
    data: {
      action: "Created",
      resource: `Group/${createdGroup.id}`,
      message: `Group ${createdGroup.name} created`,
    },
  });

  return { id: createdGroup.id, status: "created" };
}

/**
 * Update a group and fully replace any attached awareness grants.
 *
 * @param prisma - Prisma client used for persistence.
 * @param groupId - Group identifier from the route.
 * @param body - Partial route payload provided by the caller.
 * @returns Mutation response consumed by the route.
 */
export async function updateGroup(prisma: PrismaClient, groupId: string, body: Partial<GroupWriteRequest>): Promise<GroupMutationResponse>
{
  // 1. Normalize membership input before persistence so updates keep the same canonical JSON shape as creates.
  const members = body.members ? _NormalizeMembers(body.members) : undefined;

  // 2. Update the group first so its own fields reflect the latest operator intent before grants are re-written.
  await prisma.group.update({
    where: { id: groupId },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.scope ? { scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[body.scope] as Prisma.GroupUpdateInput["scope"] } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(members ? { members: members as Prisma.InputJsonValue } : {}),
    },
  });

  // 3. Replace awareness grants wholesale because the route treats the submitted grant list as authoritative.
  await prisma.grant.deleteMany({
    where: { groupId, payloadType: _PRISMA_AWARENESS_PAYLOAD_TYPE },
  });
  if (body.grants && body.grants.length > 0)
  {
    await prisma.grant.createMany({
      data: body.grants.map(function _mapGrant(grant)
      {
        return _MapGrantCreateInput(groupId, grant);
      }),
    });
  }

  // 4. Record the update after persistence so audit history reflects the new state that callers can now read back.
  await prisma.auditEntry.create({
    data: {
      action: "Updated",
      resource: `Group/${groupId}`,
      message: `Group ${groupId} updated`,
    },
  });

  return { id: groupId, status: "updated" };
}

/**
 * Delete a group and its linked awareness grants.
 *
 * @param prisma - Prisma client used for persistence.
 * @param groupId - Group identifier from the route.
 * @returns Mutation response consumed by the route.
 */
export async function deleteGroup(prisma: PrismaClient, groupId: string): Promise<GroupMutationResponse>
{
  // 1. Remove linked awareness grants first so there are no dangling compiler rows after the group disappears.
  await prisma.grant.deleteMany({
    where: { groupId, payloadType: _PRISMA_AWARENESS_PAYLOAD_TYPE },
  });

  // 2. Delete the group once linked grants are gone so the mutation stays referentially clean.
  await prisma.group.delete({
    where: { id: groupId },
  });

  // 3. Append an audit record so operators can trace destructive changes without relying on external logs.
  await prisma.auditEntry.create({
    data: {
      action: "Deleted",
      resource: `Group/${groupId}`,
      message: `Group ${groupId} deleted`,
    },
  });

  return { id: groupId, status: "deleted" };
}

/**
 * Normalize raw membership JSON into a unique, sorted string array.
 *
 * @param members - Raw request or database membership value.
 * @returns Canonical principal identifier list.
 */
function _NormalizeMembers(members: unknown): string[]
{
  if (!Array.isArray(members))
  {
    return [];
  }

  const uniqueMembers = new Set<string>();
  for (const member of members)
  {
    if (typeof member !== "string")
    {
      continue;
    }

    const normalizedMember = member.trim();
    if (normalizedMember.length === 0)
    {
      continue;
    }

    uniqueMembers.add(normalizedMember);
  }

  return ___SortBy(Array.from(uniqueMembers));
}

/**
 * Map a persisted group and its grants into the route response shape.
 *
 * @param group - Persisted group with attached grants.
 * @returns Normalized response payload.
 */
function _MapGroupResponse(group: _GroupWithGrantsRow): GroupResponse
{
  const members = _NormalizeMembers(group.members);

  return {
    id: group.id,
    name: group.name,
    scope: _ROUTE_SCOPE_BY_PRISMA_SCOPE[group.scope],
    description: group.description ?? undefined,
    members,
    memberCount: members.length,
    grants: group.grants.map(function _mapGrant(grant)
    {
      return _MapGrantResponse(grant);
    }),
  };
}

/**
 * Map a persisted grant into the route response shape.
 *
 * @param grant - Persisted grant row linked to the group.
 * @returns Route-facing grant payload.
 */
function _MapGrantResponse(grant: _GroupWithGrantsRow["grants"][number]): GroupGrantResponse
{
  return {
    id: grant.id,
    scope: _ROUTE_SCOPE_BY_PRISMA_SCOPE[grant.scope],
    subjectType: _ROUTE_SUBJECT_BY_PRISMA_SUBJECT[grant.subjectType],
    subjectId: grant.subjectId,
    subjectName: grant.subjectId,
    access: _ROUTE_ACCESS_BY_PRISMA_ACCESS[grant.access],
    ...(grant.note ? { note: grant.note } : {}),
  };
}

/**
 * Map a route grant payload into the Prisma createMany input.
 *
 * @param groupId - Group identifier linked to the grant.
 * @param grant - Route payload describing the awareness grant.
 * @returns Prisma createMany input row.
 */
function _MapGrantCreateInput(groupId: string, grant: GroupGrantInput): Prisma.GrantCreateManyInput
{
  return {
    payloadType: _PRISMA_AWARENESS_PAYLOAD_TYPE,
    payloadId: grant.payloadId ?? "awareness/default",
    scope: _PRISMA_SCOPE_BY_ROUTE_SCOPE[grant.scope] as Prisma.GrantCreateManyInput["scope"],
    subjectType: _PRISMA_SUBJECT_BY_ROUTE_SUBJECT[grant.subjectType] as Prisma.GrantCreateManyInput["subjectType"],
    subjectId: _ResolveGrantSubjectId(grant),
    access: _PRISMA_ACCESS_BY_ROUTE_ACCESS[grant.access] as Prisma.GrantCreateManyInput["access"],
    priority: grant.priority ?? 0,
    note: grant.note,
    groupId,
  };
}

/**
 * Resolve the compiler-facing subject identifier from route input.
 *
 * @param grant - Route payload describing the awareness grant.
 * @returns Stable subject identifier.
 */
function _ResolveGrantSubjectId(grant: GroupGrantInput): string
{
  return grant.subjectId ?? grant.subjectName;
}
