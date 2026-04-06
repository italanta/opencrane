import { Buffer } from "node:buffer";

import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

import type { OperatorConfig } from "../../config.js";
import { _K8sApplyResource } from "../../infra/k8s.js";
import { _BuildTenantLabels } from "../deploy/tenant-labels.js";
import type { Tenant } from "../models/tenant.interface.js";

/**
 * Handles LiteLLM virtual key provisioning and Secret materialization
 * for tenant workloads.
 */
export class TenantLiteLlmKeys
{
  /** Operator runtime configuration loaded from environment. */
  private config: OperatorConfig;

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
    config: OperatorConfig,
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

    // 2. Idempotency check — avoid regenerating keys if the Secret already exists.
    try
    {
      await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
      this.log.debug({ name, secretName }, "litellm key secret already exists");
      return;
    }
    catch
    {
      // Continue to create key and secret when missing.
    }

    // 3. Provision key in LiteLLM and persist as a namespaced Secret for tenant env injection.
    const budget = tenant.spec.monthlyBudgetUsd ?? this.config.liteLlmDefaultMonthlyBudgetUsd;
    const apiKey = await this._generateLiteLlmVirtualKey(name, budget);
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace,
        labels: _BuildTenantLabels(name),
      },
      type: "Opaque",
      data: {
        apiKey: Buffer.from(apiKey).toString("base64"),
      },
    };

    await _K8sApplyResource(this.objectApi, secret, this.log);
    this.log.info({ name, secretName, budget }, "created litellm virtual key secret");
  }

  /**
   * Request a new LiteLLM virtual key for the tenant from the LiteLLM API.
   */
  private async _generateLiteLlmVirtualKey(tenantName: string, monthlyBudgetUsd: number): Promise<string>
  {
    const response = await fetch(`${this.config.liteLlmEndpoint}/key/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.liteLlmMasterKey}`,
      },
      body: JSON.stringify({
        key_alias: `opencrane-${tenantName}`,
        metadata: { tenant: tenantName },
        max_budget: monthlyBudgetUsd,
      }),
    });

    if (!response.ok)
    {
      const body = await response.text();
      throw new Error(`LiteLLM key generation failed (${response.status}): ${body}`);
    }

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
}
