/**
 * Runtime configuration loaded from environment variables.
 */
export interface SkillRegistryConfig
{
  /** TCP port to listen on. */
  port: number;
  /** Control-plane base URL for internal entitlement + content calls. */
  controlPlaneUrl: string;
}

/**
 * Load and validate skill-registry configuration from environment variables.
 *
 * @returns Validated configuration object.
 */
export function _LoadConfig(): SkillRegistryConfig
{
  const port = parseInt(process.env["PORT"] ?? "5000", 10);
  if (!Number.isFinite(port))
  {
    throw new Error("PORT must be a valid number");
  }

  const controlPlaneUrl = process.env["CONTROL_PLANE_URL"];
  if (!controlPlaneUrl)
  {
    throw new Error("CONTROL_PLANE_URL is required");
  }

  return { port, controlPlaneUrl };
}
