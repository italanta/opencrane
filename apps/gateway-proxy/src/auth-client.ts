import { GATEWAY_RESOLVE_PATH } from "./config.js";

/** The forward target the control plane authorises for a session. */
export interface ResolvedTarget
{
  user: { email: string; sub: string };
  tenant: { name: string; clusterTenantRef: string | null };
  podService: { name: string; namespace: string };
}

/** Delegated-auth outcome: a forward target, or a closed-socket status + reason. */
export type ResolveOutcome =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: number; reason: string };

/**
 * Ask the control plane who a gateway socket belongs to and where it should go,
 * by replaying ONLY the upgrade request's `Cookie` header to
 * `GET /api/v1/auth/gateway-resolve`. The proxy holds no session state — the
 * control plane is the sole auth authority (delegate-auth, like nginx
 * `auth_request`), so the express session store is never shared across services.
 *
 * Fail closed on anything that is not a clean 200 with a well-formed body:
 *  - 401/403            → propagate (no session / no-or-ambiguous tenant).
 *  - any other status   → 502 (the control plane is the authority; if we can't get a
 *                         clean answer we refuse rather than guess a route).
 *  - network/parse error → 502.
 *
 * @param controlPlaneUrl - Internal control-plane base URL.
 * @param cookie          - The upgrade request's raw `Cookie` header, if any.
 * @param signal          - Abort signal bounding the call (upgrade timeout).
 * @returns A forward target, or a fail-closed status + reason.
 */
export async function _ResolveTarget(controlPlaneUrl: string, cookie: string | undefined, signal: AbortSignal): Promise<ResolveOutcome>
{
  const url = `${controlPlaneUrl.replace(/\/+$/, "")}${GATEWAY_RESOLVE_PATH}`;

  let res: Response;
  try
  {
    res = await fetch(url, {
      method: "GET",
      // Replay only the cookie — never client-supplied identity headers, which the
      // control plane ignores anyway (it trusts only the session).
      headers: cookie ? { cookie } : {},
      signal,
      redirect: "error",
    });
  }
  catch
  {
    return { ok: false, status: 502, reason: "control-plane unreachable" };
  }

  if (res.status === 401)
  {
    return { ok: false, status: 401, reason: "unauthenticated" };
  }
  if (res.status === 403)
  {
    return { ok: false, status: 403, reason: "forbidden (no or ambiguous tenant)" };
  }
  if (res.status !== 200)
  {
    return { ok: false, status: 502, reason: `unexpected control-plane status ${res.status}` };
  }

  let body: unknown;
  try
  {
    body = await res.json();
  }
  catch
  {
    return { ok: false, status: 502, reason: "malformed control-plane response" };
  }

  const target = _ParseTarget(body);
  if (!target)
  {
    return { ok: false, status: 502, reason: "incomplete control-plane response" };
  }
  return { ok: true, target };
}

/** Validate the control-plane body shape before trusting it as a forward target. */
function _ParseTarget(body: unknown): ResolvedTarget | null
{
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const user = b["user"] as Record<string, unknown> | undefined;
  const tenant = b["tenant"] as Record<string, unknown> | undefined;
  const pod = b["podService"] as Record<string, unknown> | undefined;

  if (!user || !tenant || !pod) return null;
  if (typeof user["email"] !== "string" || typeof user["sub"] !== "string") return null;
  if (typeof tenant["name"] !== "string") return null;
  if (typeof pod["name"] !== "string" || typeof pod["namespace"] !== "string") return null;
  if (pod["name"].length === 0 || pod["namespace"].length === 0) return null;

  return {
    user: { email: user["email"], sub: user["sub"] },
    tenant: { name: tenant["name"], clusterTenantRef: typeof tenant["clusterTenantRef"] === "string" ? tenant["clusterTenantRef"] : null },
    podService: { name: pod["name"], namespace: pod["namespace"] },
  };
}
