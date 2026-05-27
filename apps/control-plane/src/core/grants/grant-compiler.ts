import {
  GrantAccess as __PrismaGrantAccess,
  GrantPayloadType as __PrismaGrantPayloadType,
  GrantScope as __PrismaGrantScope,
  GrantSubjectType as __PrismaGrantSubjectType,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { some as ___some, sortBy as ___sortBy } from "lodash";

import {
  GrantCompilerAccess,
  GrantCompilerPayloadType,
  GrantCompilerScope,
  GrantCompilerSubjectType,
  type CompiledGrantDecision,
} from "./grant-compiler.types.js";

/** Narrow group rows to the membership fields used during compilation. */
const _GROUP_ROW_SELECT = Prisma.validator<Prisma.GroupDefaultArgs>()({
  select: {
    id: true,
    members: true,
  },
});

/** Narrow grant rows to the precedence fields used during compilation. */
const _GRANT_ROW_SELECT = Prisma.validator<Prisma.GrantDefaultArgs>()({
  select: {
    id: true,
    payloadType: true,
    payloadId: true,
    access: true,
    priority: true,
    scope: true,
    subjectType: true,
    subjectId: true,
    createdAt: true,
  },
});

/** Principal subject types that resolve directly against the caller identifier. */
const _DIRECT_SUBJECT_TYPES: __PrismaGrantSubjectType[] = [__PrismaGrantSubjectType.Tenant, __PrismaGrantSubjectType.User];

/** Compiler-facing access enum lookup keyed by Prisma enum values. */
const _COMPILER_ACCESS_BY_PRISMA_ACCESS: Record<__PrismaGrantAccess, GrantCompilerAccess> = {
  [__PrismaGrantAccess.Allow]: GrantCompilerAccess.Allow,
  [__PrismaGrantAccess.Deny]: GrantCompilerAccess.Deny,
};

/** Compiler-facing payload enum lookup keyed by Prisma enum values. */
const _COMPILER_PAYLOAD_BY_PRISMA_PAYLOAD: Record<__PrismaGrantPayloadType, GrantCompilerPayloadType> = {
  [__PrismaGrantPayloadType.Awareness]: GrantCompilerPayloadType.Awareness,
  [__PrismaGrantPayloadType.McpServer]: GrantCompilerPayloadType.McpServer,
  [__PrismaGrantPayloadType.SkillBundle]: GrantCompilerPayloadType.SkillBundle,
};

/** Compiler-facing scope enum lookup keyed by Prisma enum values. */
const _COMPILER_SCOPE_BY_PRISMA_SCOPE: Record<__PrismaGrantScope, GrantCompilerScope> = {
  [__PrismaGrantScope.Org]: GrantCompilerScope.Org,
  [__PrismaGrantScope.Department]: GrantCompilerScope.Department,
  [__PrismaGrantScope.Project]: GrantCompilerScope.Project,
  [__PrismaGrantScope.Personal]: GrantCompilerScope.Personal,
};

/** Compiler-facing subject enum lookup keyed by Prisma enum values. */
const _COMPILER_SUBJECT_BY_PRISMA_SUBJECT: Record<__PrismaGrantSubjectType, GrantCompilerSubjectType> = {
  [__PrismaGrantSubjectType.Group]: GrantCompilerSubjectType.Group,
  [__PrismaGrantSubjectType.Tenant]: GrantCompilerSubjectType.Tenant,
  [__PrismaGrantSubjectType.User]: GrantCompilerSubjectType.User,
};

type _GroupRow = Prisma.GroupGetPayload<typeof _GROUP_ROW_SELECT>;
type _GrantRow = Prisma.GrantGetPayload<typeof _GRANT_ROW_SELECT>;

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
  // 1. Load the minimum group shape needed so membership matching stays typed and isolated.
  const groupRows = await prisma.group.findMany(_GROUP_ROW_SELECT);

  // 2. Resolve every group that contains the principal because group grants are compiled alongside direct grants.
  const matchingGroupIds = groupRows.filter(function _matchGroup(group)
  {
    return _GroupHasPrincipal(group.members, principalId);
  }).map(function _mapGroup(group)
  {
    return group.id;
  });

  // 3. Fetch only grants that can apply to the principal so the later precedence pass stays deterministic and small.
  const grantRows = await prisma.grant.findMany({
    ..._GRANT_ROW_SELECT,
    where: {
      payloadType: _ToPrismaPayloadType(payloadType),
      OR: [
        {
          subjectType: {
            in: _DIRECT_SUBJECT_TYPES,
          },
          subjectId: principalId,
        },
        ...(matchingGroupIds.length > 0
          ? [
              {
                subjectType: __PrismaGrantSubjectType.Group,
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

  // 4. Walk the candidates once so deny/priority/createdAt precedence stays centralized in a single comparator.
  for (const grant of grantRows)
  {
    const nextDecision = _ToCompiledGrantDecision(grant);
    const currentWinner = winnerByPayloadId.get(grant.payloadId);

    if (!currentWinner || _ShouldReplaceWinner(currentWinner, nextDecision))
    {
      winnerByPayloadId.set(grant.payloadId, nextDecision);
    }
  }

  // 5. Emit a stable payload ordering so callers can cache and diff compiled contracts deterministically.
  return ___sortBy(Array.from(winnerByPayloadId.values()), "payloadId");
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
 * Map a typed Prisma grant row into the transport shape returned by the compiler.
 *
 * @param grant - Persisted grant row selected for compilation.
 * @returns Compiler-facing grant decision candidate.
 */
function _ToCompiledGrantDecision(grant: _GrantRow): CompiledGrantDecision
{
  return {
    grantId: grant.id,
    payloadType: _COMPILER_PAYLOAD_BY_PRISMA_PAYLOAD[grant.payloadType],
    payloadId: grant.payloadId,
    access: _COMPILER_ACCESS_BY_PRISMA_ACCESS[grant.access],
    priority: grant.priority,
    scope: _COMPILER_SCOPE_BY_PRISMA_SCOPE[grant.scope],
    subjectType: _COMPILER_SUBJECT_BY_PRISMA_SUBJECT[grant.subjectType],
    subjectId: grant.subjectId,
    createdAt: grant.createdAt.toISOString(),
  };
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
    return ___some(members, function _matchMember(member)
    {
      return _MemberMatchesPrincipal(member, principalId);
    });
  }

  if (typeof members === "object" && members !== null)
  {
    const record = members as Record<string, unknown>;

    if (Array.isArray(record.items))
    {
      return ___some(record.items, function _matchRecordItem(member)
      {
        return _MemberMatchesPrincipal(member, principalId);
      });
    }

    return ___some(Object.keys(record), function _matchRecordKey(key)
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

  return ___some(candidateValues, function _matchValue(candidateValue)
  {
    return typeof candidateValue === "string" && candidateValue === principalId;
  });
}

/**
 * Convert the transport-facing payload enum into the Prisma enum expected by queries.
 *
 * @param payloadType - Compiler payload family requested by the caller.
 * @returns Prisma enum value used in SQL filters.
 */
function _ToPrismaPayloadType(payloadType: GrantCompilerPayloadType): __PrismaGrantPayloadType
{
  switch (payloadType)
  {
    case GrantCompilerPayloadType.Awareness:
      return __PrismaGrantPayloadType.Awareness;
    case GrantCompilerPayloadType.McpServer:
      return __PrismaGrantPayloadType.McpServer;
    case GrantCompilerPayloadType.SkillBundle:
      return __PrismaGrantPayloadType.SkillBundle;
  }
}
