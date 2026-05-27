import type { PrismaClient } from "@prisma/client";

import type { CompiledGrantDecision, GrantCompilerPayloadType } from "./grant-compiler.types.js";

/**
 * Compile effective grant decisions for a principal and payload family.
 *
 * The compiler resolves direct tenant/user grants plus any group grants where the
 * principal is listed in `groups.members`. Precedence rules are deterministic:
 * highest priority wins first, deny wins over allow at the same priority, and the
 * newest `createdAt` wins the final tie-break.
 *
 * @param principalId - Tenant or user identifier being evaluated.
 * @param payloadType - Payload family to compile.
 * @param prisma - Prisma client used to load groups and grants.
 * @returns Final decision per payload identifier.
 */
export async function compile(
  principalId: string,
  payloadType: GrantCompilerPayloadType,
  prisma: PrismaClient,
): Promise<CompiledGrantDecision[]>
{
  const groupRows = await (prisma as unknown as {
    group: {
      findMany: (args: { select: { id: true; members: true } }) => Promise<Array<{ id: string; members: unknown }>>;
    };
  }).group.findMany({
    select: {
      id: true,
      members: true,
    },
  });
  const matchingGroupIds = groupRows.filter(function _matchGroup(group)
  {
    return _GroupHasPrincipal(group.members, principalId);
  }).map(function _mapGroup(group)
  {
    return group.id;
  });
  const grantRows = await (prisma as unknown as {
    grant: {
      findMany: (args: {
        where: {
          payloadType: GrantCompilerPayloadType;
          OR: Array<Record<string, unknown>>;
        };
      }) => Promise<Array<{
        id: string;
        payloadType: GrantCompilerPayloadType;
        payloadId: string;
        access: "allow" | "deny";
        priority: number;
        scope: "org" | "department" | "project" | "personal";
        subjectType: "group" | "tenant" | "user";
        subjectId: string;
        createdAt: Date;
      }>>;
    };
  }).grant.findMany({
    where: {
      payloadType,
      OR: [
        {
          subjectType: {
            in: ["tenant", "user"],
          },
          subjectId: principalId,
        },
        ...(matchingGroupIds.length > 0
          ? [
              {
                subjectType: "group",
                subjectId: {
                  in: matchingGroupIds,
                },
              },
            ]
          : []),
      ],
    },
  });
  const winnerByPayloadId = new Map<string, CompiledGrantDecision>();

  for (const grant of grantRows)
  {
    const nextDecision: CompiledGrantDecision = {
      grantId: grant.id,
      payloadType: grant.payloadType,
      payloadId: grant.payloadId,
      access: grant.access,
      priority: grant.priority,
      scope: grant.scope,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      createdAt: grant.createdAt.toISOString(),
    };
    const currentWinner = winnerByPayloadId.get(grant.payloadId);

    if (!currentWinner || _ShouldReplaceWinner(currentWinner, nextDecision))
    {
      winnerByPayloadId.set(grant.payloadId, nextDecision);
    }
  }

  return Array.from(winnerByPayloadId.values()).sort(function _sortByPayload(left, right)
  {
    return left.payloadId.localeCompare(right.payloadId);
  });
}

/**
 * Determine whether the next decision should replace the current winner.
 *
 * @param currentWinner - Current winning decision.
 * @param nextDecision - Candidate decision.
 * @returns True when the candidate outranks the current winner.
 */
function _ShouldReplaceWinner(currentWinner: CompiledGrantDecision, nextDecision: CompiledGrantDecision): boolean
{
  if (nextDecision.priority !== currentWinner.priority)
  {
    return nextDecision.priority > currentWinner.priority;
  }

  if (nextDecision.access !== currentWinner.access)
  {
    return nextDecision.access === "deny";
  }

  return Date.parse(nextDecision.createdAt) > Date.parse(currentWinner.createdAt);
}

/**
 * Check whether a group membership JSON document contains the principal.
 *
 * @param members - Raw JSON stored on the group record.
 * @param principalId - Principal identifier being matched.
 * @returns True when the principal is present.
 */
function _GroupHasPrincipal(members: unknown, principalId: string): boolean
{
  if (Array.isArray(members))
  {
    return members.some(function _matchMember(member)
    {
      return _MemberMatchesPrincipal(member, principalId);
    });
  }

  if (typeof members === "object" && members !== null)
  {
    const record = members as Record<string, unknown>;

    if (Array.isArray(record.items))
    {
      return record.items.some(function _matchRecordItem(member)
      {
        return _MemberMatchesPrincipal(member, principalId);
      });
    }

    return Object.keys(record).some(function _matchRecordKey(key)
    {
      return key === principalId || _MemberMatchesPrincipal(record[key], principalId);
    });
  }

  return false;
}

/**
 * Match a single membership entry against a principal identifier.
 *
 * @param member - Single membership entry from the JSON document.
 * @param principalId - Principal identifier being matched.
 * @returns True when the entry resolves to the principal.
 */
function _MemberMatchesPrincipal(member: unknown, principalId: string): boolean
{
  if (typeof member === "string")
  {
    return member === principalId;
  }

  if (typeof member !== "object" || member === null)
  {
    return false;
  }

  const record = member as Record<string, unknown>;
  const candidateValues = [record.id, record.principalId, record.tenant, record.userId, record.name];

  return candidateValues.some(function _matchValue(candidateValue)
  {
    return typeof candidateValue === "string" && candidateValue === principalId;
  });
}
