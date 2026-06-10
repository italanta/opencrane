import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { ___CreateControlPlaneClient } from "@opencrane/contracts";
import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _PrintApiError, type OutputFormat } from "../format.js";

/** Absolute path to the directory that holds the credentials file. */
const _CREDENTIALS_DIR = join(homedir(), ".config", "opencrane");

/** Absolute path to the persisted credentials file. */
const _CREDENTIALS_PATH = join(_CREDENTIALS_DIR, "credentials.json");

/** Device token polling interval in milliseconds (matches the server-advertised interval). */
const _POLL_INTERVAL_MS = 5_000;

/** Maximum number of poll attempts before giving up (~5 minutes at 5s intervals). */
const _MAX_POLL_ATTEMPTS = 60;

/**
 * Persist the authenticated token and base URL to the credentials file.
 * Creates the directory when it does not yet exist.
 *
 * @param token   - Plain-text access token from the device flow.
 * @param baseUrl - Raw control-plane URL (no /api/v1 suffix).
 */
function _saveCredentials(token: string, baseUrl: string): void
{
  // 1. Ensure the config directory exists before writing.
  mkdirSync(_CREDENTIALS_DIR, { recursive: true });

  // 2. Write the credentials atomically (overwrite any previous file).
  writeFileSync(
    _CREDENTIALS_PATH,
    JSON.stringify({ token, baseUrl }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Sleep for the given number of milliseconds.
 *
 * @param ms - Duration in milliseconds.
 */
async function _sleep(ms: number): Promise<void>
{
  return new Promise(function _resolve(resolve: () => void)
  {
    setTimeout(resolve, ms);
  });
}

/** Register all `oc auth *` sub-commands on the given parent Command. */
export function _RegisterAuth(parent: Command, getConfig: () => CliConfig): void
{
  const auth = parent
    .command("auth")
    .description("Inspect and manage authentication state");

  // --------------------------------------------------------------------------
  // oc auth login
  // --------------------------------------------------------------------------

  auth
    .command("login")
    .description("Authenticate the CLI via the device authorization flow (opens a browser)")
    .action(async function _login()
    {
      const config = getConfig();

      // 1. Build an unauthenticated client — the device endpoints are public.
      const client = ___CreateControlPlaneClient(config.baseUrl);

      // 2. Request a device code from the control plane.
      const { data: grant, error: grantError } = await client.POST("/auth/device", {});
      if (grantError || !grant)
      {
        _PrintApiError("auth login", grantError ?? { error: "no response from server", code: "no_response" });
        process.exit(1);
      }

      // 3. Build the full activation URL the operator must open in a browser.
      //    The verificationUri returned by the server is a relative path; we
      //    strip /api/v1 from the baseUrl so the link points to the server root.
      const serverRoot = config.baseUrl.replace(/\/api\/v1$/, "");
      const activationUrl = `${serverRoot}${grant.verificationUri}`;

      console.log("");
      console.log("Open the following URL in your browser to complete login:");
      console.log("");
      console.log(`  ${activationUrl}`);
      console.log("");
      console.log(`  User code: ${grant.userCode}`);
      console.log("");
      console.log("Waiting for browser authentication...");

      // 4. Poll GET /auth/device/token until the grant is authorized or expires.
      let attempts = 0;
      while (attempts < _MAX_POLL_ATTEMPTS)
      {
        await _sleep(_POLL_INTERVAL_MS);
        attempts++;

        const { data: poll, error: pollError } = await client.GET("/auth/device/token", {
          params: { query: { deviceCode: grant.deviceCode } },
        });

        if (pollError)
        {
          // 410 Gone — grant expired before the user activated it.
          const errObj = pollError as { status?: string; error?: string };
          if (errObj.status === "expired" || errObj.error?.includes("expired"))
          {
            console.error("error: grant expired. Run `oc auth login` again.");
            process.exit(1);
          }
          // Any other error is unexpected — bail out.
          _PrintApiError("auth login poll", pollError);
          process.exit(1);
        }

        if (poll?.status === "authorized" && poll.token)
        {
          // 5. Persist the token and base URL for future commands.
          _saveCredentials(poll.token, serverRoot);

          console.log("✓ Authenticated. Credentials saved.");
          return;
        }

        // status === "pending" — continue polling.
      }

      // Exhausted retries without a token.
      console.error("error: timed out waiting for browser authentication. Run `oc auth login` again.");
      process.exit(1);
    });

  // --------------------------------------------------------------------------
  // oc auth me
  // --------------------------------------------------------------------------

  auth
    .command("me")
    .description("Show current authentication status and identity (if any)")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _me(opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/auth/me");
      if (error)
      {
        _PrintApiError("auth me", error);
        process.exit(1);
      }

      if (opts.output === "json")
      {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const status = data as {
        mode?: string;
        authenticated?: boolean;
        user?: { sub?: string; email?: string; name?: string };
      } | undefined;

      console.log(`Mode:          ${status?.mode ?? "unknown"}`);
      console.log(`Authenticated: ${status?.authenticated ?? false}`);
      if (status?.user)
      {
        console.log(`Subject:       ${status.user.sub ?? "-"}`);
        console.log(`Email:         ${status.user.email ?? "-"}`);
        console.log(`Name:          ${status.user.name ?? "-"}`);
      }
    });

  // --------------------------------------------------------------------------
  // oc auth logout
  // --------------------------------------------------------------------------

  auth
    .command("logout")
    .description("Destroy the current server-side session and remove local credentials")
    .action(async function _logout()
    {
      const client = _MakeClient(getConfig());

      // 1. Destroy the server-side session (best-effort — failure is non-fatal).
      const { error } = await client.POST("/auth/logout", {});
      if (error)
      {
        console.warn("warning: server-side session logout failed (credentials will still be removed locally).");
      }

      // 2. Remove the local credentials file so subsequent commands prompt re-login.
      try
      {
        rmSync(_CREDENTIALS_PATH, { force: true });
      }
      catch
      {
        // Non-fatal — the file may not exist or may already be gone.
      }

      console.log("Logged out. Run `oc auth login` to sign in again.");
    });
}
