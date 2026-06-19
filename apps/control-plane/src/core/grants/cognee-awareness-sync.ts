import type { PrismaClient } from "@prisma/client";

import { _log } from "../../log.js";
import { compile } from "./grant-compiler.js";
import { GrantCompilerAccess, GrantCompilerPayloadType } from "./grant-compiler.types.js";
import type { AwarenessGrantSyncResult, CogneeAwarenessGrant, CogneeGrantTransport, PolicyPropagationResult } from "./cognee-awareness-sync.types.js";

/** Default Cognee permissions request timeout (ms) — the propagation SLO bound. */
const _DEFAULT_TIMEOUT_MS = 5000;

/** Selector keys the control-plane DB projection can resolve (team + tenant name). */
const _LABEL_TEAM = "opencrane.io/team";
const _LABEL_TENANT = "opencrane.io/tenant";

/**
 * Compile a tenant's awareness grants and push the allow/deny decisions to
 * Cognee, where the retrieval ACL is enforced (P4B.2).
 *
 * This is the awareness counterpart to the dataset-membership sync: the grant
 * compiler (priority → deny-over-allow → newest) resolves the effective
 * decisions, and Cognee filters retrieval to them. SLO-bounded via the
 * injected/default transport.
 *
 * @param prisma        - Prisma client.
 * @param tenant        - Tenant (principal) whose awareness grants to sync.
 * @param authorization - Optional inbound authorization header to forward.
 * @param transport     - Cognee transport; defaults to a fetch-based PUT.
 * @returns The per-tenant sync result (never throws — failure is captured).
 */
export async function _SyncTenantAwarenessGrants(prisma: PrismaClient,
                                                 tenant: string,
                                                 authorization: string | undefined,
                                                 transport: CogneeGrantTransport = _defaultCogneeGrantTransport): Promise<AwarenessGrantSyncResult>
{
  // 1. Compile the effective awareness decisions for this principal.
  const decisions = await compile(tenant, GrantCompilerPayloadType.Awareness, prisma);
  const grants: CogneeAwarenessGrant[] = decisions.map(function _toGrant(d): CogneeAwarenessGrant
  {
    return { payloadId: d.payloadId, access: d.access === GrantCompilerAccess.Allow ? "allow" : "deny", scope: String(d.scope) };
  });
  const allowed = grants.filter(function _isAllow(g) { return g.access === "allow"; }).length;
  const denied = grants.length - allowed;

  // 2. Push to Cognee, capturing (not throwing) failure so a downstream Cognee
  //    blip never blocks the upstream policy/grant write (DB stays source of truth).
  try
  {
    await transport(tenant, grants, authorization);
    _log.debug({ tenant, allowed, denied }, "cognee awareness grants synced");
    return { tenant, allowed, denied, ok: true };
  }
  catch (err)
  {
    _log.warn({ tenant, allowed, denied, err }, "cognee awareness grant sync failed (captured, not thrown)");
    return { tenant, allowed, denied, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve which tenants an AccessPolicy applies to, using only selector criteria
 * the control-plane DB projection can evaluate: `matchTeam` (or the
 * `opencrane.io/team` label) and the `opencrane.io/tenant` name label.
 *
 * Arbitrary Kubernetes labels live on the Tenant CR, not the DB projection, so a
 * selector keyed on them is **not** DB-resolvable here — those resolve pod-side
 * (operator effective-policy) and converge via the tenant's contract re-pull.
 * Such selectors yield an empty set with a logged note rather than a wrong match.
 *
 * @param prisma     - Prisma client.
 * @param policyName - AccessPolicy whose affected tenants to resolve.
 * @returns The DB-resolvable affected tenant names.
 */
export async function _ResolvePolicyAffectedTenants(prisma: PrismaClient, policyName: string): Promise<string[]>
{
  const policy = await prisma.accessPolicy.findUnique({ where: { name: policyName }, select: { tenantSelector: true } });
  if (!policy)
  {
    return [];
  }

  const selector = (policy.tenantSelector ?? {}) as { matchLabels?: Record<string, string>; matchTeam?: string };
  const labels = selector.matchLabels ?? {};
  const team = selector.matchTeam ?? labels[_LABEL_TEAM];
  const name = labels[_LABEL_TENANT];

  // 1. No DB-resolvable criteria → defer to pod-side reconcile; resolve nothing here.
  if (!team && !name)
  {
    _log.warn({ policyName }, "policy selector is not DB-resolvable (arbitrary labels); pod-side reconcile applies");
    return [];
  }

  // 2. Match tenants by the resolvable criteria (team and/or explicit name).
  const or: Array<Record<string, string>> = [];
  if (team) { or.push({ team }); }
  if (name) { or.push({ name }); }
  const tenants = await prisma.tenant.findMany({ where: { OR: or }, select: { name: true } });
  return tenants.map(function _name(t) { return t.name; });
}

/**
 * Propagate an AccessPolicy change to Cognee awareness grants (P4B.2).
 *
 * Resolves the affected tenants and re-syncs each one's compiled awareness
 * grants — an idempotent reconciliation so Cognee's ACL converges to the
 * current grant state whenever a policy changes. Best-effort: per-tenant
 * failures are recorded, not thrown, so policy writes never block on Cognee.
 *
 * On a policy **delete**, call `_ResolvePolicyAffectedTenants` *before* deleting
 * (the row is needed to resolve the selector), then propagate after.
 *
 * @param prisma        - Prisma client.
 * @param policyName    - The changed policy.
 * @param tenants       - Pre-resolved affected tenants (so delete can resolve pre-delete).
 * @param authorization - Optional inbound authorization header to forward.
 * @param transport     - Cognee transport; defaults to a fetch-based PUT.
 * @returns A summary of the propagation.
 */
export async function _PropagatePolicyToCognee(prisma: PrismaClient,
                                               policyName: string,
                                               tenants: string[],
                                               authorization: string | undefined,
                                               transport: CogneeGrantTransport = _defaultCogneeGrantTransport): Promise<PolicyPropagationResult>
{
  const results: AwarenessGrantSyncResult[] = [];
  for (const tenant of tenants)
  {
    results.push(await _SyncTenantAwarenessGrants(prisma, tenant, authorization, transport));
  }
  const failures = results.filter(function _failed(r) { return !r.ok; }).length;
  return { policy: policyName, tenants, results, failures };
}

/**
 * Default Cognee grant transport: an SLO-bounded `fetch` PUT of the compiled
 * awareness grants to the tenant's Cognee permissions endpoint.
 *
 * @param tenant        - Tenant whose grants are being pushed.
 * @param grants        - Compiled awareness grants.
 * @param authorization - Optional authorization header to forward.
 * @throws When `COGNEE_ENDPOINT` is unset or Cognee responds non-2xx.
 */
const _defaultCogneeGrantTransport: CogneeGrantTransport = async function _push(tenant, grants, authorization)
{
  const endpoint = process.env.COGNEE_ENDPOINT?.trim();
  if (!endpoint)
  {
    throw new Error("COGNEE_ENDPOINT is required for Cognee awareness-grant sync");
  }

  const timeoutMs = _readTimeoutMs();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cognee-tenant-id": tenant,
    "x-opencrane-sync-source": "control-plane",
  };
  if (typeof authorization === "string" && authorization.length > 0)
  {
    headers.authorization = authorization;
  }

  const url = `${endpoint.replace(/\/+$/, "")}/v1/permissions/tenants/${encodeURIComponent(tenant)}/awareness-grants`;
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ grants }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok)
  {
    throw new Error(`Cognee awareness-grant sync failed with status ${response.status}`);
  }
};

/**
 * Read the Cognee permissions timeout (ms) from the environment, falling back to
 * the default SLO bound when unset or invalid.
 */
function _readTimeoutMs(): number
{
  const raw = Number(process.env.COGNEE_PERMISSIONS_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : _DEFAULT_TIMEOUT_MS;
}
