import { Buffer } from "node:buffer";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import { __K8sApplyResource } from "../../infra/k8s.js";
import { _BuildTenantLabels } from "../deploy/tenant-labels.js";
import type { Tenant } from "../models/tenant.interface.js";

/**
 * Handles LiteLLM virtual key provisioning and Secret materialization
 * for tenant workloads.
 */
export class TenantLiteLlmKeys
{
  /** Operator runtime configuration loaded from environment. */
  private config: OpenClawTenantOperatorConfig;

  /** Client for core Kubernetes API operations (Secrets). */
  private coreApi: k8s.CoreV1Api;

  /** Client for generic Kubernetes object CRUD via server-side apply. */
  private objectApi: k8s.KubernetesObjectApi;

  /** Scoped logger for LiteLLM key lifecycle events. */
  private log: Logger;

  /**
   * Create a new LiteLLM key helper bound to the operator dependencies.
   */
  constructor(
    config: OpenClawTenantOperatorConfig,
    coreApi: k8s.CoreV1Api,
    objectApi: k8s.KubernetesObjectApi,
    log: Logger,
  )
  {
    this.config = config;
    this.coreApi = coreApi;
    this.objectApi = objectApi;
    this.log = log;
  }

  /**
   * Ensure the tenant has a LiteLLM virtual key Secret when integration is enabled.
   */
  async ensureLiteLlmKeySecret(tenant: Tenant, namespace: string): Promise<void>
  {
    // 1. Guard rails — skip when disabled and fail fast for missing master key.
    if (!this.config.liteLlmEnabled)
    {
      return;
    }

    if (!this.config.liteLlmMasterKey)
    {
      throw new Error("LITELLM_MASTER_KEY is required when LITELLM_ENABLED=true");
    }

    const name = tenant.metadata!.name!;
    const secretName = `openclaw-${name}-litellm-key`;
    const budget = tenant.spec.monthlyBudgetUsd ?? this.config.liteLlmDefaultMonthlyBudgetUsd;

    // 2. Drift reconciliation — when the Secret already exists, re-apply the
    //    budget/params to the existing key via /key/update instead of a blind
    //    early-return. The early-return left CR budget/param edits stranded (the
    //    key was minted once and never updated); /key/update converges the key to
    //    the desired spec WITHOUT minting a new value, so no pod restart is needed.
    const existingKey = await this._readExistingKeyValue(secretName, namespace);
    if (existingKey !== undefined)
    {
      await this._updateLiteLlmVirtualKey(name, existingKey, tenant, budget);
      this.log.debug({ name, secretName, budget }, "reconciled existing litellm virtual key params");
      return;
    }

    // 3. Provision key in LiteLLM and persist as a namespaced Secret for tenant env injection.
    const issuedAt = new Date().toISOString();
    const keyAlias = `opencrane-${name}`;
    const apiKey = await this._generateLiteLlmVirtualKey(tenant, budget);
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace,
        labels: _BuildTenantLabels(name),
        annotations: {
          "opencrane.io/litellm-key-alias": keyAlias,
          "opencrane.io/litellm-issued-at": issuedAt,
          "opencrane.io/litellm-monthly-budget-usd": String(budget),
        },
      },
      type: "Opaque",
      data: {
        apiKey: Buffer.from(apiKey).toString("base64"),
      },
    };

    await __K8sApplyResource(this.objectApi, secret, this.log);
    this.log.info({ name, secretName, budget }, "created litellm virtual key secret");
  }

  /**
   * Request a new LiteLLM virtual key for the tenant from the LiteLLM API.
   *
   * @param tenant - The Tenant CR; supplies team_id resolution and the alias/metadata.
   * @param monthlyBudgetUsd - Resolved monthly spend cap to attach to the new key.
   * @returns The freshly minted virtual key value.
   */
  private async _generateLiteLlmVirtualKey(tenant: Tenant, monthlyBudgetUsd: number): Promise<string>
  {
    const tenantName = tenant.metadata!.name!;

    // 1. Build the shared param block (budget window, team, rate limits) so the
    //    same hardening applied on update is applied at mint time.
    const params = this._buildKeyParams(tenant, monthlyBudgetUsd);

    // 2. Mint the key, layering the alias + tenant metadata on top of the params.
    const response = await fetch(`${this.config.liteLlmEndpoint}/key/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.liteLlmMasterKey}`,
      },
      body: JSON.stringify({
        key_alias: `opencrane-${tenantName}`,
        metadata: { tenant: tenantName },
        ...params,
      }),
    });

    if (!response.ok)
    {
      const body = await response.text();
      throw new Error(`LiteLLM key generation failed (${response.status}): ${body}`);
    }

    // 3. LiteLLM has used several response field names across versions; accept any.
    const payload = await response.json() as {
      key?: string;
      api_key?: string;
      generated_key?: string;
    };

    const key = payload.key ?? payload.api_key ?? payload.generated_key;
    if (!key)
    {
      throw new Error("LiteLLM key generation response did not include a key");
    }

    return key;
  }

  /**
   * Re-apply the desired budget/params to an existing LiteLLM virtual key via
   * `/key/update`, identifying the key by its current value so the value is
   * preserved (no rotation → no tenant pod restart).
   *
   * Best-effort and non-fatal: a LiteLLM outage must not crash the reconcile, so
   * failures are logged and swallowed (mirrors the generate-path posture, where
   * the caller wraps key provisioning in a non-blocking try/catch).
   *
   * @param tenantName - Tenant CR name, used for log correlation.
   * @param keyValue - The existing virtual key value to update in place.
   * @param tenant - The Tenant CR supplying team/budget params.
   * @param monthlyBudgetUsd - Resolved monthly spend cap to re-apply.
   */
  private async _updateLiteLlmVirtualKey(tenantName: string, keyValue: string, tenant: Tenant, monthlyBudgetUsd: number): Promise<void>
  {
    try
    {
      // 1. Build the same param block used at mint time, then pin it to the
      //    existing key value so /key/update converges params without rotating.
      const params = this._buildKeyParams(tenant, monthlyBudgetUsd);
      const response = await fetch(`${this.config.liteLlmEndpoint}/key/update`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.config.liteLlmMasterKey}`,
        },
        body: JSON.stringify({
          key: keyValue,
          ...params,
        }),
      });

      // 2. Surface a non-2xx as a warning only — the existing key keeps working
      //    with its old params, so this is drift, not an outage we should crash on.
      if (!response.ok)
      {
        const body = await response.text();
        this.log.warn({ tenant: tenantName, status: response.status, body }, "litellm key update failed; existing key params left as-is");
      }
    }
    catch (err)
    {
      this.log.warn({ tenant: tenantName, err }, "litellm key update threw; existing key params left as-is");
    }
  }

  /**
   * Read the current virtual key value from the tenant's existing Secret.
   *
   * @param secretName - The per-tenant LiteLLM key Secret name.
   * @param namespace - Namespace the Secret lives in.
   * @returns The decoded key value, or `undefined` when the Secret does not exist
   *          (the create path) or carries no `apiKey` field.
   */
  private async _readExistingKeyValue(secretName: string, namespace: string): Promise<string | undefined>
  {
    try
    {
      const secret = await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
      const encoded = secret.data?.["apiKey"];
      if (!encoded)
      {
        return undefined;
      }

      return Buffer.from(encoded, "base64").toString("utf8");
    }
    catch
    {
      // Secret missing → signal the create path to mint a new key.
      return undefined;
    }
  }

  /**
   * Build the shared LiteLLM key param block reused by generate and update so the
   * two paths can never drift apart. Only includes a field when it resolves to a
   * meaningful value (omitting team_id/limits rather than sending null/0).
   *
   * @param tenant - The Tenant CR; team_id resolves from clusterTenantRef then team.
   * @param monthlyBudgetUsd - Resolved monthly spend cap.
   * @returns A param object spread into the generate/update request body.
   */
  private _buildKeyParams(tenant: Tenant, monthlyBudgetUsd: number): Record<string, unknown>
  {
    const params: Record<string, unknown> = {
      max_budget: monthlyBudgetUsd,
      budget_duration: this.config.liteLlmBudgetDuration,
    };

    // 1. team_id — prefer the parent ClusterTenant the openclaw belongs to, fall
    //    back to the legacy team label; omit entirely when neither is set so
    //    LiteLLM does not bind the key to a non-existent team.
    const teamId = tenant.spec.clusterTenantRef ?? tenant.spec.team;
    if (teamId)
    {
      params["team_id"] = teamId;
    }

    // 2. Rate limits — sourced from config defaults (no per-tenant CR field
    //    exists); only attach when a positive limit is configured.
    if (this.config.liteLlmDefaultTpmLimit > 0)
    {
      params["tpm_limit"] = this.config.liteLlmDefaultTpmLimit;
    }

    if (this.config.liteLlmDefaultRpmLimit > 0)
    {
      params["rpm_limit"] = this.config.liteLlmDefaultRpmLimit;
    }

    return params;
  }
}
