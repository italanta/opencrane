/**
 * Runtime configuration for the identity-routing gateway proxy, loaded from the
 * environment. The proxy is a thin, logic-free choke point: it carries no secrets
 * and no session state, only the coordinates it needs to (a) ask the control plane
 * who a socket belongs to and (b) reach the resolved OpenClaw pod.
 */
export interface GatewayProxyConfig
{
  /** TCP port the proxy listens on (HTTP server + WS upgrade). */
  port: number;
  /** Internal control-plane base URL the delegated-auth call targets. */
  controlPlaneUrl: string;
  /** The OpenClaw pod gateway port the proxy forwards to (cluster-internal). */
  gatewayPort: number;
  /**
   * Header the verified identity is injected into for the pod's trusted-proxy auth
   * (must match the operator's `GATEWAY_TRUSTED_PROXY_USER_HEADER`). The proxy strips
   * any client-supplied value and sets this from the control-plane resolution.
   */
  userHeader: string;
  /** In-cluster DNS suffix for the pod Service FQDN (e.g. `svc.cluster.local`). */
  clusterDomain: string;
  /**
   * Exact `Origin` values allowed on a gateway WS upgrade (CSWSH guard) — for
   * customer-vanity hosts. CORS does NOT cover WebSockets, so this allowlist plus
   * {@link allowedOriginBaseDomains} are the only Origin defence.
   */
  allowedOrigins: string[];
  /**
   * Platform base domains; any `https://<label>.<base>` org host (or the base apex)
   * is allowed without enumerating every org. Empty AND no exact origins = fail
   * closed: every browser upgrade is refused.
   */
  allowedOriginBaseDomains: string[];
  /** Max gateway sockets one identity may open per minute (per replica). */
  rateLimitPerMinute: number;
}

/** Path of the control-plane delegated-auth/routing endpoint. */
export const GATEWAY_RESOLVE_PATH = "/api/v1/auth/gateway-resolve";

/**
 * Load and validate gateway-proxy configuration from environment variables.
 *
 * @returns Validated configuration.
 * @throws When a required variable is missing or a numeric variable is invalid.
 */
export function _LoadConfig(): GatewayProxyConfig
{
  const port = _parsePort(process.env["PORT"] ?? "8090", "PORT");

  const controlPlaneUrl = process.env["CONTROL_PLANE_URL"];
  if (!controlPlaneUrl)
  {
    throw new Error("CONTROL_PLANE_URL is required");
  }

  const gatewayPort = _parsePort(process.env["GATEWAY_PORT"] ?? "8080", "GATEWAY_PORT");
  const clusterDomain = (process.env["CLUSTER_DOMAIN"] ?? "svc.cluster.local").trim();
  const userHeader = (process.env["GATEWAY_USER_HEADER"] ?? "X-Forwarded-User").trim();

  // Comma-separated exact origins (vanity) + base domains (every-org). Empty both = fail closed.
  const allowedOrigins = _splitList(process.env["ALLOWED_ORIGINS"]);
  const allowedOriginBaseDomains = _splitList(process.env["ALLOWED_ORIGIN_BASE_DOMAINS"]);

  const rateLimitPerMinute = parseInt(process.env["RATE_LIMIT_PER_MINUTE"] ?? "60", 10);
  if (!Number.isFinite(rateLimitPerMinute) || rateLimitPerMinute <= 0)
  {
    throw new Error("RATE_LIMIT_PER_MINUTE must be a positive number");
  }

  return { port, controlPlaneUrl, gatewayPort, clusterDomain, userHeader, allowedOrigins, allowedOriginBaseDomains, rateLimitPerMinute };
}

/** Split a comma-separated env var into trimmed, non-empty entries. */
function _splitList(raw: string | undefined): string[]
{
  return (raw ?? "").split(",").map(s => s.trim()).filter(s => s.length > 0);
}

/** Parse a TCP port env var, validating the 1–65535 range. */
function _parsePort(raw: string, name: string): number
{
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 65535)
  {
    throw new Error(`${name} must be a valid TCP port (1-65535)`);
  }
  return value;
}
