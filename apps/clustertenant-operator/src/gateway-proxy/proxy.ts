import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Logger } from "pino";

import { _OriginAllowed } from "./origin.js";
import type { FixedWindowRateLimiter } from "./rate-limit.js";
import { _ResolveTarget } from "./auth-client.js";
import type { ResolveOutcome } from "./auth-client.js";

/** The proxy runtime settings the handler needs (a subset of the operator config). */
export interface GatewayProxyRuntime
{
  /** Internal control-plane base URL the delegated-auth call targets. */
  controlPlaneUrl: string;
  /** The OpenClaw pod gateway port the proxy forwards to (cluster-internal). */
  gatewayPort: number;
  /** In-cluster DNS suffix for the pod Service FQDN (e.g. `svc.cluster.local`). */
  clusterDomain: string;
  /** Header the verified identity is injected into for the pod's trusted-proxy auth. */
  userHeader: string;
  /** Exact `Origin` values allowed (CSWSH), for vanity hosts. */
  allowedOrigins: string[];
  /** Platform base domains; any `https://<org>.<base>` host is allowed (CSWSH). */
  allowedOriginBaseDomains: string[];
}

/** Minimal WS reverse-proxy surface the handler needs (satisfied by `http-proxy`). */
export interface WsProxy
{
  ws(req: IncomingMessage, socket: Duplex, head: Buffer, options: { target: string; headers?: Record<string, string> }, callback: (err: Error) => void): void;
}

/** Dependencies for {@link _HandleUpgrade}; injectable so the handler is unit-testable. */
export interface UpgradeDeps
{
  config: GatewayProxyRuntime;
  proxy: WsProxy;
  limiter: FixedWindowRateLimiter;
  log: Logger;
  /** Delegated-auth resolver; defaults to the live control-plane call. */
  resolve?: (controlPlaneUrl: string, cookie: string | undefined, host: string | undefined, signal: AbortSignal) => Promise<ResolveOutcome>;
}

/** Bound on the delegated-auth call so a slow control plane can't pin a socket open. */
const _RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Authorise and route a single gateway WebSocket upgrade — the proxy's only job, now
 * folded into the operator process.
 *
 * Order is deliberate, cheapest-and-strictest first:
 *   1. **Origin allowlist** (CSWSH) — refuse before spending a control-plane call.
 *   2. **Delegated auth** — the control plane decides identity + forward target; the
 *      proxy holds NO session logic (it only replays the cookie).
 *   3. **Per-identity rate limit** — abuse backstop, keyed on the resolved email.
 *   4. **Inject + forward** — strip any client `X-Forwarded-User`, set it from the
 *      control-plane resolution, and reverse-proxy to `openclaw-<user>.<ns>.svc:<port>`.
 *
 * Every refusal closes the socket with a status line and is logged. Cross-tenant safety
 * rests on the control plane's `gateway-resolve` (routing) plus per-pod owner pinning.
 *
 * @param deps   - Injected config, proxy, limiter, logger, and (optionally) resolver.
 * @param req    - The HTTP upgrade request.
 * @param socket - The raw client socket.
 * @param head   - The first packet of the upgraded stream.
 */
export async function _HandleUpgrade(deps: UpgradeDeps, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
{
  const { config, proxy, limiter, log } = deps;
  const resolve = deps.resolve ?? _ResolveTarget;
  const reqLog = log.child({ component: "gateway-proxy", remoteAddress: req.socket.remoteAddress, url: req.url });

  // 1. CSWSH guard — fail closed on a missing or non-allowlisted Origin.
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!_OriginAllowed(origin, config.allowedOrigins, config.allowedOriginBaseDomains))
  {
    reqLog.warn({ origin }, "gateway upgrade refused: origin not allowlisted");
    _refuse(socket, 403);
    return;
  }

  // 2. Delegated auth — the control plane is the sole authority. Forward the org host the
  //    upgrade arrived on (x-forwarded-host from the ingress, else Host) so the control plane
  //    scopes the email→tenant resolution to this silo; the internal call's own host is
  //    `opencrane-control-plane`, which would otherwise resolve nothing for a multi-silo owner.
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0].trim() : undefined;
  const host = forwardedHost ?? (typeof req.headers.host === "string" ? req.headers.host : undefined);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), _RESOLVE_TIMEOUT_MS);
  let outcome: ResolveOutcome;
  try
  {
    outcome = await resolve(config.controlPlaneUrl, req.headers.cookie, host, ac.signal);
  }
  finally
  {
    clearTimeout(timer);
  }

  if (!outcome.ok)
  {
    reqLog.warn({ status: outcome.status, reason: outcome.reason }, "gateway upgrade refused by control plane");
    _refuse(socket, outcome.status);
    return;
  }

  const { user, tenant, podService } = outcome.target;

  // 3. Per-identity rate limit — bound how many sockets one identity opens.
  if (!limiter.allow(user.email))
  {
    reqLog.warn({ email: user.email, tenant: tenant.name }, "gateway upgrade refused: rate limited");
    _refuse(socket, 429);
    return;
  }

  // 4. Strip any client-supplied identity header, inject the verified one, forward.
  delete req.headers[config.userHeader.toLowerCase()];
  const target = `ws://${podService.name}.${podService.namespace}.${config.clusterDomain}:${config.gatewayPort}`;
  reqLog.info({ email: user.email, tenant: tenant.name, target }, "gateway upgrade authorised; proxying");
  proxy.ws(req, socket, head, { target, headers: { [config.userHeader]: user.email } }, function _onProxyError(err: Error)
  {
    reqLog.error({ err, target }, "gateway proxy transport error");
    if (!socket.destroyed)
    {
      socket.destroy();
    }
  });
}

/** Standard reason phrases for the statuses the proxy emits on refusal. */
const _REASONS: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  502: "Bad Gateway",
};

/**
 * Refuse an upgrade by writing a bare HTTP response and closing the socket.
 *
 * @param socket - The raw client socket to close.
 * @param status - The HTTP status to report before closing.
 */
function _refuse(socket: Duplex, status: number): void
{
  const reason = _REASONS[status] ?? "Bad Gateway";
  try
  {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  catch
  {
    // Socket may already be gone; the destroy below is the real cleanup.
  }
  socket.destroy();
}
