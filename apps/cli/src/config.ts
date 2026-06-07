import { ___CreateControlPlaneClient } from "@opencrane/contracts";

/**
 * Resolved CLI configuration, built from environment variables and global flags.
 */
export interface CliConfig
{
  /** Full base URL including /api/v1 suffix. */
  baseUrl: string;
  /** Bearer token for Authorization header. */
  token: string;
}

/**
 * Build CliConfig from global option values.
 * Priority: explicit flag > environment variable > default.
 *
 * @param opts - Global option object from Commander (url, token).
 */
export function _ResolveConfig(opts: { url?: string; token?: string }): CliConfig
{
  // 1. Normalise the base URL: strip trailing slashes then append the versioned prefix.
  const rawUrl = opts.url ?? process.env.OPENCRANE_URL ?? "http://localhost:8080";
  const baseUrl = `${rawUrl.replace(/\/+$/, "")}/api/v1`;

  // 2. Resolve the bearer token from the flag, the environment, or default to empty.
  const token = opts.token ?? process.env.OPENCRANE_TOKEN ?? "";

  // 3. Reject early when no token is present — every API endpoint requires one.
  if (!token)
  {
    console.error("error: authentication token is required. Set OPENCRANE_TOKEN or pass --token <token>");
    process.exit(1);
  }

  return { baseUrl, token };
}

/**
 * Create a typed control-plane client from resolved CLI config.
 *
 * @param config - Resolved CLI configuration.
 */
export function _MakeClient(config: CliConfig)
{
  return ___CreateControlPlaneClient(config.baseUrl, config.token);
}
