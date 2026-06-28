/** Path of the control-plane delegated-auth/routing endpoint. */
export const GATEWAY_RESOLVE_PATH = "/api/v1/auth/gateway-resolve";

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
 * Ask the control plane who a gateway socket belongs to and where it should go, by
 * replaying the upgrade request's `Cookie` header — and the org host it arrived on — to
 * `GET /api/v1/auth/gateway-resolve`. The proxy holds no session state — the control
 * plane is the sole auth authority (delegate-auth), so the session store is never
 * shared. Even folded into the operator, the proxy makes no auth decision locally.
 *
 * The original org host (`<clusterTenant>.<base>`) is forwarded as `x-forwarded-host` so
 * the control plane can scope the email→tenant resolution to the silo the socket is for.
 * This internal call targets `opencrane-control-plane:8080`, so without it the control
 * plane would see the internal host and fail to resolve a multi-silo owner (no/ambiguous
 * tenant → 403).
 *
 * Fail closed on anything that is not a clean 200 with a well-formed body:
 *  - 401/403            → propagate (no session / no-or-ambiguous tenant).
 *  - any other status   → 502 (refuse rather than guess a route).
 *  - network/parse error → 502.
 *
 * @param controlPlaneUrl - Internal control-plane base URL.
 * @param cookie          - The upgrade request's raw `Cookie` header, if any.
 * @param host            - The org host the upgrade arrived on, forwarded for silo scoping.
 * @param signal          - Abort signal bounding the call (upgrade timeout).
 * @returns A forward target, or a fail-closed status + reason.
 */
export async function _ResolveTarget(controlPlaneUrl: string, cookie: string | undefined, host: string | undefined, signal: AbortSignal): Promise<ResolveOutcome>
{
  const url = `${controlPlaneUrl.replace(/\/+$/, "")}${GATEWAY_RESOLVE_PATH}`;

  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  if (host) headers["x-forwarded-host"] = host;

  let res: Response;
  try
  {
    res = await fetch(url, {
      method: "GET",
      headers,
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
