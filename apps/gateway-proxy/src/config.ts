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
  /** In-cluster DNS suffix for the pod Service FQDN (e.g. `svc.cluster.local`). */
  clusterDomain: string;
  /**
   * Exact `Origin` values allowed on a gateway WS upgrade (CSWSH guard). Empty =
   * fail closed: every browser upgrade is refused until the operator configures the
   * org host(s). CORS does NOT cover WebSockets, so this is the only Origin defence.
   */
  allowedOrigins: string[];
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

  // Comma-separated exact origins; blank entries dropped. Empty list = fail closed.
  const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map(o => o.trim())
    .filter(o => o.length > 0);

  const rateLimitPerMinute = parseInt(process.env["RATE_LIMIT_PER_MINUTE"] ?? "60", 10);
  if (!Number.isFinite(rateLimitPerMinute) || rateLimitPerMinute <= 0)
  {
    throw new Error("RATE_LIMIT_PER_MINUTE must be a positive number");
  }

  return { port, controlPlaneUrl, gatewayPort, clusterDomain, allowedOrigins, rateLimitPerMinute };
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
