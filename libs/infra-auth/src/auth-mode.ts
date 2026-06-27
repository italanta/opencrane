import { ___LoadOidcAuthConfig } from "./oidc-config.js";

/**
 * True when the manager runs with NO real auth configured — neither OIDC nor an
 * `OPENCRANE_API_TOKEN`. This is the dev-mode bypass, mirroring the condition in
 * `___AuthMiddleware` (`!_envToken && !_oidcConfig.enabled`).
 *
 * Scope guards and read-time scope filters use this to decide their fallthrough posture for a
 * request with no established session: **fail OPEN under dev mode** (so a fresh local install or
 * an OPEN dev backend isn't locked out) and **fail CLOSED otherwise** — a missing session in a
 * real auth deployment must never reach a scoped mutation or leak cross-tenant reads.
 *
 * Reads the environment live (OIDC config is env-derived) so it reflects the current process
 * configuration, including in tests that set the env before issuing a request.
 *
 * If the OIDC config can't be loaded (partial/invalid config), treat it as NOT dev mode — i.e.
 * fail closed (deny) rather than throwing a 500 or silently opening the bypass.
 *
 * @returns True when no real auth is configured (dev-mode bypass active).
 */
export function _IsDevAuthMode(): boolean
{
  const envToken = process.env.OPENCRANE_API_TOKEN?.trim() ?? "";
  if (envToken !== "")
  {
    return false;
  }
  try
  {
    return !___LoadOidcAuthConfig().enabled;
  }
  catch
  {
    return false;
  }
}
