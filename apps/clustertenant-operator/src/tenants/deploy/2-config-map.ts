import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { AccessPolicy } from "../../policies/types.js";
import type { Tenant } from "../models/tenant.interface.js";
import type { TenantModelSet } from "@opencrane/contracts";
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
 *        control-plane, or `null`. When LiteLLM is enabled the `litellm-proxy` provider runs in
 *        `replace` mode (it is the ONLY provider), restricted to these models with the default
 *        surfaced. An empty/null result yields `models: []` — and because there are no built-in
 *        providers to fall back to, the pod then has zero usable models. Cluster onboarding makes
 *        that impossible by requiring ≥1 registered model before a silo is provisioned; a transient
 *        control-plane outage at reconcile is the only window it can occur, and it self-heals on the
 *        next successful fetch.
 * @param servingHost - The host the org's Control UI is served at (`<org>.<base>` or
 *        vanity), used to allowlist the browser Origin in `gateway.controlUi.allowedOrigins`.
 *        With `bind: lan` the gateway rejects a Control-UI WS whose Origin is not allowlisted
 *        (`CONTROL_UI_ORIGIN_NOT_ALLOWED`); the SPA reaches the gateway via this host, so its
 *        `https://<host>` origin must be allowed. Omitted ⇒ no origin is added (the gateway's
 *        own localhost seeding applies — the pre-same-origin behaviour).
 */
export function _BuildConfigMap(config: OpenClawTenantOperatorConfig, tenant: Tenant, namespace: string, effectivePolicy?: AccessPolicy, modelSet?: TenantModelSet | null, servingHost?: string): k8s.V1ConfigMap
{
  const name = tenant.metadata!.name!;

  // 0. Allowed models — the litellm-proxy provider (the ONLY provider under `replace` mode below)
  //    is restricted to the tenant's registered set. An empty or null result yields `[]`; with no
  //    built-ins to fall back to that means no usable models, which onboarding prevents by requiring
  //    ≥1 registered model before provisioning (the empty case is only reachable on a transient
  //    control-plane outage at reconcile, and self-heals on the next fetch).
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
      // Control-UI (org-admin SPA) policy:
      //  - allowedOrigins: with bind:lan the gateway enforces a Control-UI Origin allowlist
      //    (since v2026.2.26) and refuses an unlisted Origin with CONTROL_UI_ORIGIN_NOT_ALLOWED.
      //    The SPA reaches the gateway through the org host, so allow its https origin (when known).
      //  - dangerouslyDisableDeviceAuth: this platform is device-less by design — identity is the
      //    OIDC session the operator proxy verifies and injects as X-Forwarded-User (CONN.4), not a
      //    per-browser device key. Without this flag the gateway connects a trusted-proxy Control-UI
      //    but STRIPS its operator scopes (shouldClearUnboundScopesForMissingDeviceIdentity), so
      //    chat RPCs fail "missing scope". Disabling device auth lets the proxy be the authority and
      //    the connect's scopes stand. SAFE ONLY IF the gateway port is reachable solely through the
      //    proxy — enforced by the openclaw-<name>-gateway NetworkPolicy. NOTE: that requires the
      //    cluster to actually ENFORCE NetworkPolicy (Dataplane V2 / Calico); the dev cluster does
      //    not yet — tracked separately. The owner-pin (auth.allowUsers) is defence-in-depth, not a
      //    substitute (a caller that asserts the owner email is trusted under trusted-proxy).
      controlUi: {
        dangerouslyDisableDeviceAuth: true,
        ...(servingHost ? { allowedOrigins: [`https://${servingHost}`] } : {}),
      },
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
              // `replace` (not `merge`): the litellm-proxy provider REPLACES OpenClaw's built-in
              // providers, so EVERY model call must go through LiteLLM — no bare-provider bypass of
              // the virtual key / budget metering / BYOK upstream key. This makes a non-empty model
              // allowlist a hard requirement (an empty list ⇒ the pod has zero usable models), which
              // cluster onboarding enforces by requiring at least one registered model before a silo
              // is provisioned (see fleet-operator ClusterTenant readiness). The BYOK key flow also
              // auto-seeds a default model, so a key-configured silo always satisfies this.
              mode: "replace",
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
 * Deterministic SHA-256 over a ConfigMap's `data` block, for the pod-template
 * `opencrane.io/config-checksum` annotation (see `_BuildDeployment`).
 *
 * WHY: OpenClaw reads `openclaw.json` only at process START. A mounted ConfigMap
 * update (e.g. a newly-registered BYOK default model landing in the `models`
 * block) refreshes the file on disk but does NOT restart the running process, so
 * a pod that booted before its models existed stays on the keyless
 * `gateway-injected` fallback forever. Stamping this digest on the pod template
 * makes any config change alter the template → the Recreate strategy rolls the
 * pod → OpenClaw re-reads the config and picks up the LiteLLM default model.
 *
 * Keys are sorted so the digest is stable across reconciles (no spurious rolls);
 * the values are the already-deterministic rendered config strings.
 */
export function _ConfigChecksum(configMap: k8s.V1ConfigMap): string
{
  const data = configMap.data ?? {};
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return createHash("sha256").update(canonical).digest("hex");
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

