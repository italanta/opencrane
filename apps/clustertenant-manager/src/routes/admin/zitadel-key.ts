import { Router } from "express";

import { _RequirePlatformOperator } from "@opencrane/infra-auth";
import type { ZitadelKeySecretStore } from "../../infra/zitadel/key-secret-store.js";
import type { ZitadelManagementClient } from "../../infra/zitadel/zitadel-client.types.js";
import { _log } from "../../log.js";

/**
 * Normalise the request body's candidate key into a JSON string. The route accepts either a
 * JSON STRING (the downloaded SA key file content) or an already-parsed OBJECT (a client that
 * posted the parsed key), and re-serialises an object so the downstream signer always gets a
 * string. Returns null when the field is absent or an empty/blank string (a 400 input error).
 *
 * @param raw - The `serviceAccountKey` field from the request body.
 */
function _NormaliseCandidateKey(raw: unknown): string | null
{
  if (typeof raw === "string")
  {
    return raw.trim() === "" ? null : raw;
  }
  if (raw && typeof raw === "object")
  {
    return JSON.stringify(raw);
  }
  return null;
}

/**
 * Superadmin-gated router for rotating the platform's Zitadel service-account key — the master
 * IdP credential. The whole point of this route is the SAFE-ROTATION invariant: the live key is
 * swapped ONLY AFTER the candidate is proven (a) able to authenticate and (b) holding the
 * instance-level `IAM_OWNER` scope the platform depends on. If validation fails the route
 * returns 422 with NO change and the old key stays active.
 *
 * Mounted at `/api/v1/admin/zitadel`, behind {@link _RequirePlatformOperator}. Only the
 * multi-tenant (cluster-tenant manager) path constructs the Zitadel client, so this router is
 * mounted only there (see `routes.ts`).
 *
 * @param client      - The LIVE Zitadel management client; validated candidates are swapped into it.
 * @param secretStore - Persistence for the SA key Secret; persist-first so a restart keeps the new key.
 * @returns Configured Express router.
 */
export function zitadelKeyRouter(client: ZitadelManagementClient, secretStore: ZitadelKeySecretStore): Router
{
  const router = Router();

  router.use(_RequirePlatformOperator());

  /**
   * Rotate the platform Zitadel SA key. Body: `{ serviceAccountKey: string | object }`.
   * Flow: validate → (persist → reload) on success, 422 (no change) on validation failure.
   */
  router.post("/sa-key:rotate", async function _rotateSaKey(req, res)
  {
    // 1. Normalise + validate the input shape (a missing/blank candidate is a 400, not a 422 —
    //    422 is reserved for a well-formed candidate that FAILED the live validation gate).
    const candidate = _NormaliseCandidateKey((req.body as { serviceAccountKey?: unknown } | undefined)?.serviceAccountKey);
    if (candidate === null)
    {
      res.status(400).json({ error: "Request body must include a non-empty `serviceAccountKey` (JSON string or object).", code: "INVALID_REQUEST" });
      return;
    }

    // 2. Refuse loud when persistence is not configured — an in-memory-only swap would silently
    //    revert to the old key on the next pod restart, so a misconfigured deploy must fail here
    //    rather than appear to rotate. Checked BEFORE validation so we never validate-then-strand.
    if (!secretStore.isConfigured())
    {
      _log.warn({}, "zitadel key rotation: refused — key-Secret persistence not configured (ZITADEL_MGMT_SECRET_NAME unset)");
      res.status(409).json({ error: "Key-Secret persistence is not configured; cannot rotate the Zitadel service-account key safely.", code: "SECRET_PERSISTENCE_NOT_CONFIGURED" });
      return;
    }

    // 3. Validate the candidate against the live instance: jwt-bearer exchange + a
    //    non-destructive instance-`IAM_OWNER` probe. A transport error here is a 5xx (thrown).
    let validation;
    try
    {
      validation = await client.validateCandidateKey(candidate);
    }
    catch (err)
    {
      _log.error({ err }, "zitadel key rotation: transport error validating candidate key (no change)");
      res.status(502).json({ error: "Failed to reach Zitadel to validate the candidate key; no change was made.", code: "ZITADEL_UNREACHABLE" });
      return;
    }

    // 4. SAFE-ROTATION gate: accept ONLY when BOTH the token exchange and the instance scope
    //    probe pass. Anything less leaves the live key untouched and returns 422.
    if (!validation.tokenExchangeOk || !validation.instanceScopeOk)
    {
      _log.warn({ keyId: validation.keyId, tokenExchangeOk: validation.tokenExchangeOk, instanceScopeOk: validation.instanceScopeOk }, "zitadel key rotation: candidate REJECTED — validation failed (live key unchanged)");
      res.status(422).json({ rotated: false, validation });
      return;
    }

    // 5. Capture the outgoing keyId for the audit trail before the swap, then PERSIST FIRST:
    //    if the Secret write fails we must NOT swap in-memory (else memory and Secret diverge,
    //    and a restart reverts the live key). A persist failure is a 5xx — old key stays active.
    const previousKeyId = client.currentKeyId();
    try
    {
      await secretStore.persistKey(candidate);
    }
    catch (err)
    {
      _log.error({ keyId: validation.keyId, err }, "zitadel key rotation: candidate validated but persisting to the Secret FAILED (live key unchanged)");
      res.status(500).json({ error: "The candidate key was valid but could not be persisted; no change was made.", code: "KEY_PERSIST_FAILED" });
      return;
    }

    // 6. Persisted — now make the validated key live (atomic in-memory swap + token-cache clear).
    client.reloadKey(candidate);
    _log.info({ keyId: validation.keyId, previousKeyId }, "zitadel key rotation: ROTATED — live service-account key replaced after validation + persistence");
    res.status(200).json({ rotated: true, keyId: validation.keyId, previousKeyId, validation });
  });

  return router;
}
