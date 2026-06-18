/**
 * Route-local types for the Langfuse metrics proxy (AIR.10). The proxy returns an upstream
 * passthrough (loosely typed), so the only shapes here are the resolved server-side config and the
 * caller scope used to inject a tenant constraint into the forwarded query.
 */

/**
 * The resolved, server-side Langfuse connection config. Built from the environment; null when any
 * required field is missing (host or either key) — the proxy then answers 503 `unconfigured`.
 */
export interface LangfuseConfig
{
  /** Base URL of the self-hosted Langfuse instance, e.g. `https://langfuse.internal`. */
  host: string;
  /** Langfuse public key — used as the HTTP Basic auth username. */
  publicKey: string;
  /** Langfuse secret key — used as the HTTP Basic auth password (never leaves the server). */
  secretKey: string;
  /** The metrics API path appended to the host. Defaults to the Langfuse v1 metrics path. */
  metricsPath: string;
}

/**
 * The caller's resolved authorization scope for query injection (AIR.10). An operator (and the dev
 * open-auth fallthrough) forwards the query unconstrained; a non-operator has the query constrained
 * to their own ClusterTenant via a tenant-dimension filter.
 */
export interface MetricsCallerScope
{
  /** True when the caller is a platform operator (no tenant constraint injected). */
  isOperator: boolean;
  /** The caller's own ClusterTenant ref when resolved; null when unresolved/ambiguous. */
  clusterTenant: string | null;
}
