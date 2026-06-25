import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { AccessPolicy } from "../../policies/types.js";
import type { Tenant } from "../models/tenant.interface.js";
import type { TenantModelSet } from "../internal/tenant-models.types.js";
import { _BuildTenantLabels } from "./tenant-labels.js";

/** Directory containing the workspace template files shipped with the operator. */
const _WORKSPACE_TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "workspace");

/** Absolute path inside the tenant pod where OpenClaw's persistent workspace lives. */
const _WORKSPACE_PATH = "/data/openclaw/workspace";

/**
 * Build the tenant ConfigMap that carries both OpenClaw runtime configuration
 * and the OpenCrane managed-runtime contract.
 *
 * The generated ConfigMap serves three purposes:
 * - `openclaw.json` provides the effective OpenClaw gateway/runtime config
 *   after OpenCrane defaults are merged with any tenant overrides.
 * - `opencrane-managed-runtime.json` gives the tenant runtime an explicit
 *   description of the platform context it is running under.
 * - Workspace files (`AGENTS.md`, `TOOLS.md`, `SOUL.md.seed`, etc.) are
 *   seeded into the OpenClaw agent workspace by `entrypoint.sh` on boot.
 *   L0 files (no `.seed` suffix) are re-stamped on every boot; L2 files
 *   (`.seed` suffix) are copied once and then tenant-owned.
 *
 * @param config - Operator runtime configuration.
 * @param tenant - The Tenant CR being reconciled.
 * @param namespace - Namespace the ConfigMap is written to.
 * @param effectivePolicy - The resolved AccessPolicy, when one applies.
 * @param modelSet - The tenant's allowed model set fetched best-effort from the
 *        control-plane, or `null`. When non-empty (and LiteLLM is enabled) the
 *        `litellm-proxy` provider is restricted to those models and the default
 *        model is surfaced; when empty/null the provider keeps `models: []`
 *        (unchanged today's behaviour — OpenClaw treats `[]` as the proxy default).
 */
export function _BuildConfigMap(config: OpenClawTenantOperatorConfig, tenant: Tenant, namespace: string, effectivePolicy?: AccessPolicy, modelSet?: TenantModelSet | null): k8s.V1ConfigMap
{
  const name = tenant.metadata!.name!;

  // 0. Allowed models — restrict the litellm-proxy provider to the tenant's
  //    registered set when the control-plane returned a non-empty list. An empty
  //    or null result falls back to `[]` (unchanged), so a control-plane outage
  //    never narrows or breaks the tenant's model access.
  const allowedModels = modelSet && modelSet.models.length > 0 ? [...modelSet.models] : [];
  const defaultModel = modelSet?.defaultModel ?? null;

  // Owner identity this pod is pinned to. The gateway-verify broker injects the
  // session's verified email trimmed + lowercased, so the allowlist MUST use the
  // same normalisation or it would lock the owner out.
  const ownerEmail = tenant.spec.email.trim().toLowerCase();

  // 1. Base runtime config — establish the OpenClaw gateway defaults that every
  //    tenant needs before any tenant-specific overrides are applied.
  const baseConfig: Record<string, unknown> = {
    gateway: {
      mode: "local",
      port: config.gatewayPort,
      bind: "lan",
      // OC-2 / CONN.4 — the gateway delegates auth to the control-plane: the pod
      // ingress validates the OIDC session and injects the user header, and the
      // gateway trusts it only from the configured proxy source. No shared token
      // (mutually exclusive with trusted-proxy); a NetworkPolicy locks the port
      // to the ingress so the trusted range can't be abused by other pods.
      //
      // Fail-closed by construction: OpenClaw treats an empty `trustedProxies`
      // as "trust no source" (gateway `isTrustedProxyAddress` returns false for
      // every IP when the list is empty), so when the operator was given no proxy
      // source the user header is never honoured and no connection authenticates —
      // an unconfigured operator denies, it does not trust-all. The internal
      // `config.gatewayTrustNothing` flag records this posture for the operator;
      // it is deliberately NOT rendered, because OpenClaw needs no extra marker
      // and its `trustedProxy` schema is strict (unknown keys crash the gateway).
      trustedProxies: config.gatewayTrustedProxies,
      // CONN.10 — pin the pod to its OWNER. trusted-proxy trusts whatever identity
      // the proxy injects, so without `allowUsers` ANY authenticated platform user
      // who reaches this pod (e.g. by hitting another tenant's host) is accepted as
      // themselves — a cross-tenant gap, since the pod holds the owner's mounted
      // secrets / MCP connections / model keys. `allowUsers` makes the gateway reject
      // any X-Forwarded-User that isn't the owner, so per-pod ownership is enforced
      // server-side regardless of how the connection is routed (host or identity proxy).
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: config.gatewayTrustedProxyUserHeader,
          allowUsers: [ownerEmail],
        },
      },
    },
    ...(config.liteLlmEnabled
      ? {
            models: {
              mode: "merge",
              ...(defaultModel ? { default: defaultModel } : {}),
              providers: {
                "litellm-proxy": {
                  baseUrl: config.liteLlmEndpoint,
                  apiKey: "${LITELLM_API_KEY}",
                  api: "openai-completions",
                  models: allowedModels,
                },
              },
            },
          }
      : {}),
  };

  // 2. Managed-runtime contract — publish OpenCrane-owned capabilities and
  //    tenant context in a machine-readable form for runtime features.
  //    mcp.servers and skills.entitled are advisory stubs only; the live
  //    compiled grant is served by GET /api/tenants/:name/effective-contract
  //    and re-pulled by the pod at each agentic-loop boundary. The ingress
  //    planes (Obot MCP Gateway, Skill Registry) are the authoritative boundary.
  const runtimeContract = {
    version: "opencrane-runtime/v1alpha1",
    contractVersion: "2.1.0",
    platform: "opencrane",
    mode: "managed",
    tenant: {
      name,
      team: tenant.spec.team ?? null,
      policyRef: tenant.spec.policyRef ?? null,
    },
    policy: {
      effectiveRef: effectivePolicy?.metadata?.name ?? tenant.spec.policyRef ?? null,
    },
    mcp: {
      gateway: config.mcpGatewayUrl,
      // Actual compiled server grants are fetched from effective-contract at runtime.
      servers: [],
    },
    skills: {
      registry: config.skillRegistryUrl,
      // Actual entitled skill index is fetched from effective-contract at runtime.
      entitled: [],
    },
    capabilities: {
      liteLlmProxy: config.liteLlmEnabled,
      hostingProvider: config.hostingProvider,
      persistentState: true,
      ephemeralSecrets: true,
      autoSuspend: config.idleTimeoutMinutes > 0,
    },
  };

  // 3. Tenant overrides — shallow-merge tenant customization on top of the base config.
  const tenantMerged: Record<string, unknown> = tenant.spec.configOverrides
    ? { ...baseConfig, ...tenant.spec.configOverrides }
    : { ...baseConfig };

  // 3b. Re-pin the platform-owned `gateway` block (CONN.10) — applied AFTER the tenant
  //     merge so `spec.configOverrides.gateway` can never clobber it. The shallow merge
  //     in step 3 is top-level: a tenant `gateway` override REPLACES the whole block,
  //     which would drop the owner-pin (auth.trustedProxy.allowUsers=[owner]) and could
  //     inject a stray key that crashes the strict gateway schema on boot. Restoring
  //     baseConfig.gateway verbatim keeps the security-critical block under platform
  //     control while every non-gateway override still applies. This mirrors the
  //     agents.defaults re-application in step 4. A fresh spread (not the baseConfig
  //     reference) keeps `merged` free of aliasing into the local baseConfig object.
  tenantMerged["gateway"] = { ...(baseConfig["gateway"] as Record<string, unknown>) };

  // 4. Platform-owned agent workspace settings — applied after the tenant merge so
  //    they cannot be overridden by spec.configOverrides.  The workspace path must
  //    be pinned to the persistent volume; skipBootstrap prevents the interactive
  //    Q&A ritual in the headless pod environment.
  const existingAgents = tenantMerged["agents"] as Record<string, unknown> | undefined;
  const existingDefaults = (existingAgents?.["defaults"] as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = {
    ...tenantMerged,
    agents: {
      ...(existingAgents ?? {}),
      defaults: {
        ...existingDefaults,
        workspace: _WORKSPACE_PATH,
        skipBootstrap: true,
      },
    },
  };

  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `openclaw-${name}-config`,
      namespace,
      labels: _BuildTenantLabels(name),
    },
    data: {
      // OpenClaw consumes this file directly at tenant runtime startup.
      "openclaw.json": JSON.stringify(merged, null, 2),

      // OpenCrane-specific runtime metadata kept separate from OpenClaw's own config.
      "opencrane-managed-runtime.json": JSON.stringify(runtimeContract, null, 2),

      // L0 workspace files — platform-managed, re-stamped on every pod boot by entrypoint.sh.
      "AGENTS.md": _ReadWorkspaceTemplate("AGENTS.md"),
      "TOOLS.md": _ReadWorkspaceTemplate("TOOLS.md"),

      // L2 workspace files (.seed suffix) — copied once by entrypoint.sh when the
      // target file is absent; subsequent edits by the tenant are preserved.
      "SOUL.md.seed": _ReadWorkspaceTemplate("SOUL.md.seed"),
      "IDENTITY.md.seed": _ReadWorkspaceTemplate("IDENTITY.md.seed"),
      "USER.md.seed": _ReadWorkspaceTemplate("USER.md.seed"),
    },
  };
}

/**
 * Read a workspace template file from the `workspace/` directory co-located with
 * this module.  At build time the files are copied to `dist/tenants/deploy/workspace/`
 * alongside the compiled JS, so the same relative path resolves in both source and dist.
 *
 * @param filename - Bare filename inside the workspace templates dir (e.g. `AGENTS.md`).
 */
function _ReadWorkspaceTemplate(filename: string): string
{
  return readFileSync(join(_WORKSPACE_TEMPLATES_DIR, filename), "utf-8");
}

