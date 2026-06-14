import { GrantCompilerAccess } from "../grants/grant-compiler.types.js";
import type { CompiledGrantDecision } from "../grants/grant-compiler.types.js";
import type { ScopeIntersection, ScopeLevel, ScopeSelector } from "./session-scope.types.js";

/** The valid organizational scope levels (matches the grant-compiler scope enum values). */
const _SCOPE_LEVELS: readonly ScopeLevel[] = ["org", "department", "project", "personal"];

/**
 * Normalise a requested scope-selector list: trim payload ids, drop empty/unknown
 * entries, and dedupe by `payloadId` (the last occurrence wins) so the intersection
 * pass sees a clean, deterministic set.
 *
 * @param requested - Raw selectors as proposed by the client.
 * @returns The cleaned, deduped selector list.
 */
export function _NormalizeScopeSelectors(requested: ScopeSelector[]): ScopeSelector[]
{
  const byPayloadId = new Map<string, ScopeSelector>();
  for (const sel of requested)
  {
    const payloadId = typeof sel?.payloadId === "string" ? sel.payloadId.trim() : "";
    if (payloadId.length === 0 || !_SCOPE_LEVELS.includes(sel.scope))
    {
      continue;
    }
    byPayloadId.set(payloadId, { scope: sel.scope, payloadId });
  }
  return Array.from(byPayloadId.values());
}

/**
 * Intersect a requested scope set with a principal's compiled awareness
 * entitlements (P4B.7). This is the anti-spill authorisation core: a client can
 * never bind a session to a scope the principal's grants do not allow.
 *
 * The grant compiler has already resolved precedence (priority → deny-over-allow →
 * newest), so the allow-set is simply the winning decisions whose access is
 * `Allow`. A granted selector adopts the *authoritative* scope from the winning
 * grant (never the client-claimed one), so a client cannot spoof a payload into a
 * broader level than its grant assigns.
 *
 * @param requested - Selectors proposed by the frontend/CLI.
 * @param decisions - The principal's compiled awareness grant decisions.
 * @returns The granted (entitled) and rejected (over-scope) selector partition.
 */
export function _IntersectSessionScope(requested: ScopeSelector[], decisions: CompiledGrantDecision[]): ScopeIntersection
{
  // 1. Build the allow-set: payloadId → authoritative scope for every Allow decision.
  const allowByPayloadId = new Map<string, ScopeLevel>();
  for (const d of decisions)
  {
    if (d.access === GrantCompilerAccess.Allow)
    {
      allowByPayloadId.set(d.payloadId, d.scope as ScopeLevel);
    }
  }

  // 2. Partition the normalised request into granted (entitled, authoritative scope)
  //    and rejected (no Allow decision for the payload → over-scope attempt).
  const granted: ScopeSelector[] = [];
  const rejected: ScopeSelector[] = [];
  for (const sel of _NormalizeScopeSelectors(requested))
  {
    const authoritativeScope = allowByPayloadId.get(sel.payloadId);
    if (authoritativeScope)
    {
      granted.push({ scope: authoritativeScope, payloadId: sel.payloadId });
    }
    else
    {
      rejected.push(sel);
    }
  }

  return { granted, rejected };
}
