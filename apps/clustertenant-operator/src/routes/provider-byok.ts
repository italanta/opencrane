import { Router } from "express";
import * as k8s from "@kubernetes/client-node";
import { ByokProvider } from "@opencrane/contracts";
import type { ProviderKeyStatus } from "@opencrane/contracts";
import { _RequireOrgAdmin } from "@opencrane/infra-auth";
import type { PrismaClient, ProviderCredential as PrismaProviderCredential } from "@prisma/client";

import { _log } from "../log.js";
import { _DeprovisionByokKey, _ProvisionByokKey } from "../core/model-routing/provision-byok-key.js";

/** The providers a raw BYOK key may be set for; mirrors the {@link ByokProvider} contract union. */
const _BYOK_PROVIDERS = Object.values(ByokProvider) as readonly string[];

/**
 * Project a persisted {@link PrismaProviderCredential} row (or its absence) into the read-side
 * status DTO. `litellmRegistered` reflects whether the row carries a `litellmCredentialName` — set
 * only when LiteLLM accepted the key on the dynamic path; a Secret-only key reports `false`. Never
 * carries key material.
 *
 * @param provider - The provider this status describes.
 * @param row      - The persisted credential row, or undefined when no key is set.
 */
function _toStatus(provider: string, row: PrismaProviderCredential | undefined): ProviderKeyStatus
{
  return {
    provider: provider as ByokProvider,
    configured: Boolean(row),
    litellmRegistered: Boolean(row?.litellmCredentialName),
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Router for BYOK provider keys — set/refresh/remove a RAW upstream provider key for this silo.
 *
 * Unlike {@link providerCredentialsRouter} (reference-only, raw keys rejected), this is the BYOK
 * "dynamic no-restart path". The provisioning work (Secret write + LiteLLM `/credentials` + the
 * Global ProviderCredential row + default-model seed) lives in {@link _ProvisionByokKey} so the
 * boot-time bootstrap can reuse it; this router is the HTTP wrapper (validation + status DTO).
 * Reads return presence + timestamps only — the key is never echoed back.
 *
 * Authz: the silo-wide key spends real money and backs every model call, so mutations are gated by
 * `_RequireOrgAdmin` — only an IdP-verified org admin may set or remove it. Reads stay open.
 *
 * @param prisma            - Prisma client used for the credential record.
 * @param coreApi           - Kubernetes Core V1 API client for Secret writes.
 * @param operatorNamespace - The operator's own namespace; where the key Secret is written.
 * @returns Configured Express router.
 */
export function providerByokRouter(prisma: PrismaClient, coreApi: k8s.CoreV1Api, operatorNamespace: string): Router
{
  const router = Router();

  /** List BYOK key status for every supported provider (presence + timestamps, no key material). */
  router.get("/", async function _listProviderKeys(_req, res)
  {
    const rows = await prisma.providerCredential.findMany({
      where: { scope: "Global", clusterTenant: null, provider: { in: [..._BYOK_PROVIDERS] } },
    });
    const byProvider = new Map(rows.map(function _byProvider(row) { return [row.provider, row]; }));
    res.json(_BYOK_PROVIDERS.map(function _status(provider) { return _toStatus(provider, byProvider.get(provider)); }));
  });

  /** Set or refresh a provider's raw key (delegates the provisioning to {@link _ProvisionByokKey}). */
  router.put("/:provider", _RequireOrgAdmin(), async function _setProviderKey(req, res)
  {
    const provider = String(req.params.provider ?? "").trim().toLowerCase();
    if (!_BYOK_PROVIDERS.includes(provider))
    {
      res.status(400).json({ error: `Unsupported provider '${provider}'. Supported: ${_BYOK_PROVIDERS.join(", ")}.`, code: "UNSUPPORTED_PROVIDER" });
      return;
    }
    const apiKey = String((req.body ?? {}).apiKey ?? "").trim();
    if (!apiKey)
    {
      res.status(400).json({ error: "apiKey is required.", code: "VALIDATION_ERROR" });
      return;
    }

    const { litellmRegistered, row } = await _ProvisionByokKey({ prisma, coreApi, operatorNamespace, provider, apiKey, log: _log });
    _log.info({ provider, litellmRegistered }, "byok provider key set");
    res.json(_toStatus(provider, row));
  });

  /** Remove a provider's key (delegates to {@link _DeprovisionByokKey}). */
  router.delete("/:provider", _RequireOrgAdmin(), async function _deleteProviderKey(req, res)
  {
    const provider = String(req.params.provider ?? "").trim().toLowerCase();
    if (!_BYOK_PROVIDERS.includes(provider))
    {
      res.status(400).json({ error: `Unsupported provider '${provider}'. Supported: ${_BYOK_PROVIDERS.join(", ")}.`, code: "UNSUPPORTED_PROVIDER" });
      return;
    }

    await _DeprovisionByokKey({ prisma, coreApi, operatorNamespace, provider });
    _log.info({ provider }, "byok provider key removed");
    res.status(204).send();
  });

  return router;
}
