import type { OpenClawPairingLink } from "./openclaw-pairing-provision.types.js";

/**
 * Decode an OpenClaw setup code into a pairing link (CONN.3).
 *
 * Accepts either form a provisioning step may capture from
 * `openclaw qr --setup-code-only [--json]`:
 *   1. the raw setup code — base64 of `{ url, bootstrapToken }`; or
 *   2. the `--json` envelope wrapping the code under `setupCode`/`code`/`data`.
 *
 * The base64(`{ url, bootstrapToken }`) shape is the documented invariant (it
 * matches the control-plane broker); the envelope field name is tolerated
 * because the exact `--json` key is not pinned in the published docs.
 *
 * @param raw - The setup code string or the CLI `--json` stdout.
 * @returns The decoded pairing link.
 * @throws When no `bootstrapToken` can be recovered from the input.
 */
export function _ParseOpenClawSetupCode(raw: string): OpenClawPairingLink
{
  const trimmed = raw.trim();
  if (trimmed.length === 0)
  {
    throw new Error("empty OpenClaw setup code");
  }

  // 1. If the input is the CLI `--json` envelope, pull the inner setup-code string
  //    out of it; otherwise treat the whole input as the setup code itself.
  const setupCode = _UnwrapJsonEnvelope(trimmed) ?? trimmed;

  // 2. Decode the base64 setup code into the `{ url, bootstrapToken }` payload —
  //    the shape the gateway encodes and the broker also produces.
  const payload = _DecodeBase64Json(setupCode);
  const bootstrapToken = typeof payload?.bootstrapToken === "string" ? payload.bootstrapToken.trim() : "";
  if (bootstrapToken.length === 0)
  {
    throw new Error("OpenClaw setup code carried no bootstrapToken");
  }

  // 3. Map the gateway URL through unchanged when present (the broker derives a
  //    wss:// fallback when absent, so it is optional here).
  const gatewayUrl = typeof payload?.url === "string" && payload.url.length > 0 ? payload.url : undefined;
  return { gatewayUrl, bootstrapToken };
}

/**
 * Pull the inner setup-code string out of a CLI `--json` envelope.
 *
 * @param input - Candidate JSON string.
 * @returns The setup-code string, or null when the input is not such an envelope.
 */
function _UnwrapJsonEnvelope(input: string): string | null
{
  if (!input.startsWith("{"))
  {
    return null;
  }
  try
  {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    // If the envelope already exposes the payload directly, re-encode it so the
    // single base64-decode path below handles every case uniformly.
    if (typeof parsed.bootstrapToken === "string")
    {
      return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64");
    }
    for (const key of ["setupCode", "code", "data"])
    {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0)
      {
        return value;
      }
    }
    return null;
  }
  catch
  {
    return null;
  }
}

/**
 * Decode a base64 setup code into its JSON payload.
 *
 * @param setupCode - Base64-encoded `{ url, bootstrapToken }`.
 * @returns The decoded object, or null when it is not valid base64 JSON.
 */
function _DecodeBase64Json(setupCode: string): { url?: string; bootstrapToken?: string } | null
{
  try
  {
    const json = Buffer.from(setupCode, "base64").toString("utf8");
    return JSON.parse(json) as { url?: string; bootstrapToken?: string };
  }
  catch
  {
    return null;
  }
}
