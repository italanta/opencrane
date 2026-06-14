import { Prisma, type PrismaClient } from "@prisma/client";

import { compile } from "../grants/grant-compiler.js";
import { GrantCompilerPayloadType } from "../grants/grant-compiler.types.js";
import { _IntersectSessionScope } from "./session-scope.js";
import type { BindSessionScopeResult, ScopeIntersection, ScopeSelector, SessionScopeBinding } from "./session-scope.types.js";

/**
 * Bind (upsert) a session's awareness scope, authorised against the principal's
 * compiled entitlements (P4B.7).
 *
 * The control plane is the source of truth: it compiles the principal's awareness
 * grants, intersects the requested scope with them (`_IntersectSessionScope`), and
 * persists only the granted subset. A client therefore can never over-scope a
 * session beyond what grants allow. When nothing is entitled the binding is not
 * written (`binding: null`) and every requested selector is reported as rejected.
 *
 * @param prisma    - Prisma client.
 * @param sessionKey - OpenClaw chat-window session key.
 * @param principal  - Tenant/user that owns the session (entitlements compiled against this).
 * @param requested  - The scope selectors proposed by the frontend/CLI.
 * @returns The persisted binding (or null) and the rejected over-scope selectors.
 */
export async function _BindSessionScope(prisma: PrismaClient,
                                        sessionKey: string,
                                        principal: string,
                                        requested: ScopeSelector[]): Promise<BindSessionScopeResult>
{
  // 1. Compile the principal's awareness entitlements and intersect with the request.
  const decisions = await compile(principal, GrantCompilerPayloadType.Awareness, prisma);
  const intersection: ScopeIntersection = _IntersectSessionScope(requested, decisions);

  // 2. Nothing entitled → do not persist a meaningless empty binding; surface the rejects.
  if (intersection.granted.length === 0)
  {
    return { binding: null, rejected: intersection.rejected };
  }

  // 3. Upsert the binding with the authorised (granted) scope set only.
  const scopesJson = intersection.granted as unknown as Prisma.InputJsonValue;
  const row = await prisma.sessionScope.upsert({
    where: { sessionKey },
    create: { sessionKey, principal, scopes: scopesJson },
    update: { principal, scopes: scopesJson },
  });

  return { binding: _ToBinding(row), rejected: intersection.rejected };
}

/**
 * Load a session's scope binding.
 *
 * @param prisma    - Prisma client.
 * @param sessionKey - OpenClaw chat-window session key.
 * @returns The binding, or null when the session has no scope bound.
 */
export async function _GetSessionScope(prisma: PrismaClient, sessionKey: string): Promise<SessionScopeBinding | null>
{
  const row = await prisma.sessionScope.findUnique({ where: { sessionKey } });
  return row ? _ToBinding(row) : null;
}

/**
 * Clear a session's scope binding (idempotent — clearing an absent binding is a no-op).
 *
 * @param prisma    - Prisma client.
 * @param sessionKey - OpenClaw chat-window session key.
 * @returns Whether a binding row was deleted.
 */
export async function _ClearSessionScope(prisma: PrismaClient, sessionKey: string): Promise<boolean>
{
  const result = await prisma.sessionScope.deleteMany({ where: { sessionKey } });
  return result.count > 0;
}

/**
 * Map a persisted session-scope row into the transport-facing binding shape.
 *
 * @param row - The persisted row (scopes stored as JSON).
 * @returns The binding with parsed scope selectors and ISO timestamps.
 */
function _ToBinding(row: { sessionKey: string; principal: string; scopes: Prisma.JsonValue; createdAt: Date; updatedAt: Date }): SessionScopeBinding
{
  return {
    sessionKey: row.sessionKey,
    principal: row.principal,
    scopes: (Array.isArray(row.scopes) ? row.scopes : []) as unknown as ScopeSelector[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
