import {
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
const _GROUP_ROW_SELECT = {
  select: {
    id: true,
    members: true,
  },
} as const;

/** Narrow grant rows to the precedence fields used during compilation. */
const _GRANT_ROW_SELECT = {
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
} as const;

/** Typed Prisma payload values used during runtime lookups. */
const _PRISMA_GRANT_PAYLOAD_TYPE = {
  Awareness: "Awareness",
  McpServer: "McpServer",
  SkillBundle: "SkillBundle",
} as const;

/** Typed Prisma access values used during runtime lookups. */
const _PRISMA_GRANT_ACCESS = {
  Allow: "Allow",
  Deny: "Deny",
} as const;

/** Typed Prisma scope values used during runtime lookups. */
const _PRISMA_GRANT_SCOPE = {
  Org: "Org",
  Department: "Department",
  Project: "Project",
  Personal: "Personal",
} as const;

/** Typed Prisma subject values used during runtime lookups. */
const _PRISMA_GRANT_SUBJECT_TYPE = {
  Group: "Group",
  Tenant: "Tenant",
  User: "User",
} as const;

/** Principal subject types that resolve directly against the caller identifier. */
const _DIRECT_SUBJECT_TYPES = [_PRISMA_GRANT_SUBJECT_TYPE.Tenant, _PRISMA_GRANT_SUBJECT_TYPE.User];

/** Compiler-facing access enum lookup keyed by Prisma enum values. */
const _COMPILER_ACCESS_BY_PRISMA_ACCESS = {
  [_PRISMA_GRANT_ACCESS.Allow]: GrantCompilerAccess.Allow,
  [_PRISMA_GRANT_ACCESS.Deny]: GrantCompilerAccess.Deny,
};

/** Compiler-facing payload enum lookup keyed by Prisma enum values. */
const _COMPILER_PAYLOAD_BY_PRISMA_PAYLOAD = {
  [_PRISMA_GRANT_PAYLOAD_TYPE.Awareness]: GrantCompilerPayloadType.Awareness,
  [_PRISMA_GRANT_PAYLOAD_TYPE.McpServer]: GrantCompilerPayloadType.McpServer,
  [_PRISMA_GRANT_PAYLOAD_TYPE.SkillBundle]: GrantCompilerPayloadType.SkillBundle,
};

/** Compiler-facing scope enum lookup keyed by Prisma enum values. */
const _COMPILER_SCOPE_BY_PRISMA_SCOPE = {
  [_PRISMA_GRANT_SCOPE.Org]: GrantCompilerScope.Org,
  [_PRISMA_GRANT_SCOPE.Department]: GrantCompilerScope.Department,
  [_PRISMA_GRANT_SCOPE.Project]: GrantCompilerScope.Project,
  [_PRISMA_GRANT_SCOPE.Personal]: GrantCompilerScope.Personal,
};

/** Compiler-facing subject enum lookup keyed by Prisma enum values. */
const _COMPILER_SUBJECT_BY_PRISMA_SUBJECT = {
  [_PRISMA_GRANT_SUBJECT_TYPE.Group]: GrantCompilerSubjectType.Group,
  [_PRISMA_GRANT_SUBJECT_TYPE.Tenant]: GrantCompilerSubjectType.Tenant,
  [_PRISMA_GRANT_SUBJECT_TYPE.User]: GrantCompilerSubjectType.User,
};

type _PrismaGrantAccess = typeof _PRISMA_GRANT_ACCESS[keyof typeof _PRISMA_GRANT_ACCESS];
type _PrismaGrantScope = typeof _PRISMA_GRANT_SCOPE[keyof typeof _PRISMA_GRANT_SCOPE];
type _PrismaGrantSubjectType = typeof _PRISMA_GRANT_SUBJECT_TYPE[keyof typeof _PRISMA_GRANT_SUBJECT_TYPE];
type _PrismaGrantPayloadType = keyof typeof _COMPILER_PAYLOAD_BY_PRISMA_PAYLOAD;
type _GroupRow = { id: string; members: unknown };
type _GrantRow = {
  id: string;
  payloadType: _PrismaGrantPayloadType;
  payloadId: string;
  access: _PrismaGrantAccess;
  priority: number;
  scope: _PrismaGrantScope;
  subjectType: _PrismaGrantSubjectType;
  subjectId: string;
  createdAt: Date;
};

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
  const groupRows: _GroupRow[] = await prisma.group.findMany(_GROUP_ROW_SELECT);

  // 2. Resolve every group that contains the principal because group grants are compiled alongside direct grants.
  const matchingGroupIds = groupRows.filter(function _matchGroup(group: _GroupRow)
  {
    return _GroupHasPrincipal(group.members, principalId);
  }).map(function _mapGroup(group: _GroupRow)
  {
    return group.id;
  });

  // 3. Fetch only grants that can apply to the principal so the later precedence pass stays deterministic and small.
  const grantRows: _GrantRow[] = await prisma.grant.findMany({
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
                subjectType: _PRISMA_GRANT_SUBJECT_TYPE.Group,
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
    return nextDecision.access === GrantCompilerAccess.Deny;
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

    return ___some(record, function _matchRecordValue(value, key)
    {
      return key === principalId || _MemberMatchesPrincipal(value, principalId);
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
function _ToPrismaPayloadType(payloadType: GrantCompilerPayloadType): _PrismaGrantPayloadType
{
  switch (payloadType)
  {
    case GrantCompilerPayloadType.Awareness:
      return _PRISMA_GRANT_PAYLOAD_TYPE.Awareness;
    case GrantCompilerPayloadType.McpServer:
      return _PRISMA_GRANT_PAYLOAD_TYPE.McpServer;
    case GrantCompilerPayloadType.SkillBundle:
      return _PRISMA_GRANT_PAYLOAD_TYPE.SkillBundle;
  }
}
