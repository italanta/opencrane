import { readFileSync } from "fs";

import type { Command } from "commander";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _PrintApiError, _PrintSuccess } from "../format.js";

/**
 * Register all `oc admin *` sub-commands on the given parent Command.
 *
 * This group is gated platform-operator — the control-plane enforces the IAM
 * check; the CLI just surfaces the outcome.
 *
 * @param parent    - The root commander program.
 * @param getConfig - Lazily resolves the CLI config (base URL + auth) per invocation.
 */
export function _RegisterAdmin(parent: Command, getConfig: () => CliConfig): void
{
  const admin = parent
    .command("admin")
    .description("Superadmin operations (platform-operator gated)");

  _registerZitadel(admin, getConfig);
}

/**
 * Register all `oc admin zitadel *` sub-commands on the given parent Command.
 *
 * @param parent    - The `admin` commander sub-command.
 * @param getConfig - Lazily resolves the CLI config (base URL + auth) per invocation.
 */
function _registerZitadel(parent: Command, getConfig: () => CliConfig): void
{
  const zitadel = parent
    .command("zitadel")
    .description("Zitadel platform-admin operations (service-account key management)");

  zitadel
    .command("rotate-key")
    .description(
      "Validate and rotate the platform Zitadel service-account key. "
      + "The candidate key is validated (jwt-bearer exchange + instance IAM_OWNER probe) before it goes live. "
      + "On validation failure the old key stays active and the command exits non-zero.",
    )
    .option("--key-file <path>", "Path to the Zitadel SA key JSON file (preferred — keeps key material off the shell history)")
    .option("--key <json>", "Zitadel SA key as a raw JSON string (use --key-file in production)")
    .action(async function _rotateKey(opts: { keyFile?: string; key?: string })
    {
      // 1. Resolve the candidate key JSON from --key-file, --key, or stdin.
      //    Never echo key material; it travels in the request body only.
      let serviceAccountKey: string;

      if (opts.keyFile)
      {
        // Read from file — the safest path: nothing appears in shell history or process args.
        serviceAccountKey = readFileSync(opts.keyFile, "utf8").trim();
      }
      else if (opts.key)
      {
        // Inline JSON provided via --key.
        serviceAccountKey = opts.key;
      }
      else
      {
        // Fall back to stdin so operators can pipe the key file.
        serviceAccountKey = await _readStdin();
      }

      // 2. Validate that we actually received something before hitting the wire.
      if (!serviceAccountKey)
      {
        console.error("error: admin zitadel rotate-key — provide a key via --key-file <path>, --key <json>, or stdin.");
        process.exit(1);
      }

      // 3. POST the candidate key to the control-plane rotate endpoint.
      const client = _MakeClient(getConfig());
      const { data, error, response } = await client.POST("/admin/zitadel/sa-key:rotate", {
        body: { serviceAccountKey },
      });

      // 4. Transport / HTTP error (network failure, 400, 403, 409, etc.).
      if (error)
      {
        _PrintApiError("admin zitadel rotate-key", error);
      }

      // 5. Validation failure (422) — key was not accepted, old key is still live.
      //    Surface the validation flags so the operator can see exactly why it failed.
      if (response.status === 422 || (data && !data.rotated))
      {
        const v = data?.validation;
        console.error("error: admin zitadel rotate-key — candidate key failed validation; no change was made.");
        if (v)
        {
          console.error(`  tokenExchangeOk  : ${String(v.tokenExchangeOk)}`);
          console.error(`  instanceScopeOk  : ${String(v.instanceScopeOk)}`);
          if (v.detail) { console.error(`  detail           : ${v.detail}`); }
        }
        process.exit(1);
      }

      // 6. Success — the new key is live. Print the key-id pair (never the material itself).
      _PrintSuccess(`Zitadel SA key rotated successfully.`);
      console.log(`  newKeyId      : ${data?.keyId ?? "(unknown)"}`);
      console.log(`  previousKeyId : ${data?.previousKeyId ?? "(none)"}`);
    });
}

/**
 * Consume all of stdin and return the contents as a trimmed string.
 * Used when neither --key-file nor --key is supplied.
 */
async function _readStdin(): Promise<string>
{
  // 1. Collect incoming chunks into a buffer list to avoid string concatenation overhead.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
  {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  // 2. Join all chunks and decode as UTF-8.
  return Buffer.concat(chunks).toString("utf8").trim();
}
