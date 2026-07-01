import { ___DoWithTrace } from "@opencrane/observability";

import { _log } from "../../log.js";
import type { LiteLlmCredentialUpsert } from "./litellm-credential-registration.types.js";

/**
 * Per-request timeout for the LiteLLM `/credentials` calls. Bounds the boot-time bootstrap (which
 * awaits these) so a hung or unreachable LiteLLM cannot wedge silo controller startup — on timeout
 * the fetch aborts, the catch returns `false`, and the key stays Secret-only until the next attempt.
 */
const _LITELLM_HTTP_TIMEOUT_MS = 10_000;

/**
 * Best-effort upsert of a provider credential into LiteLLM via its `/credentials` API — the
 * BYOK "dynamic no-restart path" the contract describes (see ProviderCredential.litellmCredentialName).
 *
 * Guarded by `LITELLM_ENDPOINT` + `LITELLM_MASTER_KEY`: when either is unset (dev / tests) this is
 * a no-op returning `false`, so the BYOK set path stays functional without a live LiteLLM — the
 * raw key still persists to its k8s Secret and the ProviderCredential row, and the credential can
 * be reconciled later. The call is non-fatal and isolated: a LiteLLM error also returns `false`
 * rather than failing the request, mirroring the resilient posture of `_RegisterLiteLlmModel`.
 *
 * Upsert is implemented as delete-then-create so a refreshed key always replaces the stored value
 * regardless of whether the LiteLLM build exposes a credential update verb.
 *
 * @param input - The credential name, provider, and raw key to store in LiteLLM.
 * @returns `true` when LiteLLM accepted the credential; `false` when unconfigured or on any error.
 */
export async function _UpsertLiteLlmCredential(input: LiteLlmCredentialUpsert): Promise<boolean>
{
  const endpoint = process.env.LITELLM_ENDPOINT?.trim() ?? "";
  const masterKey = process.env.LITELLM_MASTER_KEY?.trim() ?? "";
  if (!endpoint || !masterKey)
  {
    _log.debug({ credentialName: input.credentialName, provider: input.provider, configured: false }, "litellm credential upsert skipped (unconfigured)");
    return false;
  }

  return ___DoWithTrace(
    "litellm.credential.upsert",
    { credentialName: input.credentialName, provider: input.provider },
    function _upsert(): Promise<boolean> { return _upsertLive(endpoint, masterKey, input); },
  );
}

/**
 * Best-effort delete of a LiteLLM credential by name (used on BYOK key removal). Mirrors the
 * resilient posture above: unconfigured or any non-OK / error is swallowed and returns `false`,
 * never failing the caller's delete of the Secret + DB row.
 *
 * @param credentialName - The LiteLLM credential name to remove.
 * @returns `true` when LiteLLM acknowledged the delete; `false` when unconfigured or on any error.
 */
export async function _DeleteLiteLlmCredential(credentialName: string): Promise<boolean>
{
  const endpoint = process.env.LITELLM_ENDPOINT?.trim() ?? "";
  const masterKey = process.env.LITELLM_MASTER_KEY?.trim() ?? "";
  if (!endpoint || !masterKey)
  {
    return false;
  }

  return ___DoWithTrace(
    "litellm.credential.delete",
    { credentialName },
    function _delete(): Promise<boolean> { return _deleteLive(endpoint, masterKey, credentialName); },
  );
}

/**
 * Perform the live delete-then-create against LiteLLM. The delete clears any prior value so a
 * refreshed key replaces it; the create stores the new value. Either step failing is logged as a
 * warning and yields `false` — the request still succeeds with the key persisted to its Secret.
 *
 * @param endpoint  - LiteLLM base URL.
 * @param masterKey - LiteLLM bearer credential.
 * @param input     - The credential to upsert.
 */
async function _upsertLive(endpoint: string, masterKey: string, input: LiteLlmCredentialUpsert): Promise<boolean>
{
  try
  {
    // 1. Clear any existing value first so a refresh is a true replace (idempotent — 404 is fine).
    await _deleteLive(endpoint, masterKey, input.credentialName);

    // 2. Create the credential carrying the raw key inline. LiteLLM encrypts it at rest with
    //    LITELLM_SALT_KEY; the key is never echoed back and never written to OpenClaw's config.
    const response = await fetch(`${endpoint}/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        credential_name: input.credentialName,
        credential_info: { custom_llm_provider: input.provider },
        credential_values: { api_key: input.apiKey },
      }),
      signal: AbortSignal.timeout(_LITELLM_HTTP_TIMEOUT_MS),
    });

    if (!response.ok)
    {
      _log.warn({ credentialName: input.credentialName, provider: input.provider, status: response.status }, "litellm credential upsert failed; key persisted to Secret only");
      return false;
    }

    _log.info({ credentialName: input.credentialName, provider: input.provider }, "litellm credential upserted");
    return true;
  }
  catch (err)
  {
    _log.warn({ credentialName: input.credentialName, provider: input.provider, err }, "litellm credential upsert errored; key persisted to Secret only");
    return false;
  }
}

/**
 * Perform the live `DELETE /credentials/<name>` call, treating a 404 as success (already gone).
 *
 * @param endpoint       - LiteLLM base URL.
 * @param masterKey      - LiteLLM bearer credential.
 * @param credentialName - The credential name to remove.
 */
async function _deleteLive(endpoint: string, masterKey: string, credentialName: string): Promise<boolean>
{
  try
  {
    const response = await fetch(`${endpoint}/credentials/${encodeURIComponent(credentialName)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${masterKey}` },
      signal: AbortSignal.timeout(_LITELLM_HTTP_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 404)
    {
      _log.warn({ credentialName, status: response.status }, "litellm credential delete failed");
      return false;
    }

    return true;
  }
  catch (err)
  {
    _log.warn({ credentialName, err }, "litellm credential delete errored");
    return false;
  }
}
