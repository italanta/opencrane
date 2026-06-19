import { ___DoWithTrace } from "@opencrane/observability";

import { _log } from "../../log.js";
import type { LiteLlmModelRegistration } from "./litellm-model-registration.types.js";

/**
 * Best-effort GLOBAL registration of a model with LiteLLM via `POST /model/new`.
 *
 * Guarded by `LITELLM_ENDPOINT` + `LITELLM_MASTER_KEY`: when either is unset (dev / tests),
 * this returns a deterministic placeholder id derived from `publicModelName` and never calls
 * out, so the control-plane create path stays functional without a live LiteLLM. The call is
 * non-fatal and isolated — a LiteLLM error also falls back to the placeholder rather than
 * failing the create, mirroring the resilient-fetch posture elsewhere in the platform.
 *
 * The registration is intentionally GLOBAL: it never sets `model_info.team_id` (Enterprise-gated).
 * Per-tenant access is scoped later via the virtual key's `models[]` allowlist, not here.
 *
 * @param input - The public slug, upstream model, and optional api_base/secret env reference.
 * @returns The LiteLLM-returned deployment id, or a deterministic placeholder when unconfigured.
 */
export async function _RegisterLiteLlmModel(input: LiteLlmModelRegistration): Promise<string>
{
  const endpoint = process.env.LITELLM_ENDPOINT?.trim() ?? "";
  const masterKey = process.env.LITELLM_MASTER_KEY?.trim() ?? "";
  const configured = Boolean(endpoint && masterKey);

  // 1. Unconfigured (dev / tests): skip the network call and return a stable placeholder
  //    so creates succeed and are reproducible without a live LiteLLM.
  if (!configured)
  {
    const placeholder = _placeholderModelId(input);
    _log.debug({ publicModelName: input.publicModelName, configured: false, litellmModelId: placeholder }, "litellm model registration skipped (unconfigured)");
    return placeholder;
  }

  return ___DoWithTrace(
    "litellm.model.register",
    { publicModelName: input.publicModelName, upstreamModel: input.upstreamModel, scope: input.scope },
    function _register(): Promise<string> { return _registerLive(endpoint, masterKey, input); },
  );
}

/**
 * Perform the live `POST /model/new` registration against LiteLLM, falling back to a deterministic
 * placeholder on any non-OK response or network/parse error so the create path never fails.
 * @param endpoint  - LiteLLM base URL.
 * @param masterKey - LiteLLM bearer credential.
 * @param input     - The registration inputs.
 * @returns The LiteLLM deployment id, or a placeholder when the call fails.
 */
async function _registerLive(endpoint: string, masterKey: string, input: LiteLlmModelRegistration): Promise<string>
{
  try
  {
    // 2. Register the deployment GLOBALLY. `api_key` is an `os.environ/<KEY>` reference so the
    //    raw key never transits OpenCrane — LiteLLM reads it from its own synced environment.
    const litellmParams: Record<string, unknown> = { model: input.upstreamModel };
    if (input.apiBase)
    {
      litellmParams.api_base = input.apiBase;
    }
    if (input.apiKeyEnvRef)
    {
      litellmParams.api_key = `os.environ/${input.apiKeyEnvRef}`;
    }

    const response = await fetch(`${endpoint}/model/new`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        model_name: input.publicModelName,
        litellm_params: litellmParams,
      }),
    });

    // 3. On any non-OK upstream response fall back to the placeholder — the row still persists,
    //    and the deployment can be reconciled later; the create must not fail on a flaky LiteLLM.
    if (!response.ok)
    {
      _log.warn({ publicModelName: input.publicModelName, status: response.status }, "litellm model registration failed; using placeholder id");
      return _placeholderModelId(input);
    }

    const payload = await response.json() as { model_id?: string; id?: string; model_info?: { id?: string } };
    const litellmModelId = payload.model_id ?? payload.id ?? payload.model_info?.id ?? _placeholderModelId(input);
    _log.info({ publicModelName: input.publicModelName, litellmModelId }, "litellm model registered");
    return litellmModelId;
  }
  catch (err)
  {
    // 4. Network / parse failure is non-fatal — keep the create working with a placeholder.
    _log.warn({ publicModelName: input.publicModelName, err }, "litellm model registration errored; using placeholder id");
    return _placeholderModelId(input);
  }
}

/**
 * Build a deterministic placeholder deployment id, used when LiteLLM is unconfigured or
 * unreachable. The id incorporates scope + owning clusterTenant so it stays unique under the
 * `litellmModelId` global `@unique` constraint even when the same `publicModelName` is
 * registered at different scopes (e.g. a Global model and a ClusterTenant override sharing a
 * slug). Deterministic so tests and the unique constraint behave predictably.
 *
 * @param input - The registration inputs carrying the slug, scope, and owning clusterTenant.
 * @returns A stable `placeholder:<scope>:<clusterTenant?>:<slug>` id.
 */
function _placeholderModelId(input: LiteLlmModelRegistration): string
{
  const parts = [input.scope, input.clusterTenant ?? "", input.publicModelName].join(":");
  const slug = parts.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `placeholder:${slug}`;
}
