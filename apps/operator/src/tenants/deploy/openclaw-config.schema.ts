import { z } from "zod";

/**
 * Vendored zod schema for the `openclaw.json` the operator emits, used to
 * validate the rendered config in the contract test (task_d611ab4d).
 *
 * PINNED OpenClaw version: 2026.6.x (operator `config.ts` `defaultOpenclawVersion`
 * = "2026.6.9"). OpenClaw is shipped as a container image, not an npm dependency,
 * so its canonical schema is not importable; this file VENDORS a strict best-effort
 * mirror of the documented config schema for the subset of keys the operator emits.
 *
 * Source (researched 2026-06-25 from primary OpenClaw docs):
 *   - https://docs.openclaw.ai/gateway/configuration-reference
 *   - https://docs.openclaw.ai/gateway/configuration
 *   - https://docs.openclaw.ai/gateway/trusted-proxy-auth
 *
 * What is PINNED vs INFERRED:
 *   - PINNED (verbatim from docs): gateway.mode ∈ {local,remote}; gateway.bind ∈
 *     {auto,loopback,lan,tailnet,custom}; gateway.auth.mode ∈
 *     {none,token,password,trusted-proxy}; models.mode ∈ {merge,replace}. The docs
 *     state OpenClaw "only accepts configurations that fully match the schema —
 *     unknown keys cause the gateway to refuse to start", so every object below is
 *     `.strict()` (unknown keys rejected). This is exactly the `trustNothing`-class
 *     regression that crashed live tenants (f6afafd).
 *   - INFERRED (best-effort, not byte-for-byte from the canonical JSON Schema): the
 *     exact optionality/typing of `trustedProxy.userHeader`/`allowUsers`, the
 *     `models.providers.*` field set (baseUrl/apiKey/api/models), and the
 *     `agents.defaults` shape. These mirror what the operator emits and the
 *     documented field names; widen them here if OpenClaw's `openclaw config schema`
 *     output later proves a looser shape.
 */

/** Bind modes the OpenClaw gateway accepts (docs: configuration-reference). */
const _bindMode = z.enum(["auto", "loopback", "lan", "tailnet", "custom"]);

/** Auth modes the OpenClaw gateway accepts (docs: configuration-reference). */
const _authMode = z.enum(["none", "token", "password", "trusted-proxy"]);

/**
 * Trusted-proxy auth block. INFERRED optionality: the operator always emits both
 * keys, but the docs describe `allowUsers` as an optional allowlist, so it is
 * `.optional()` here while `userHeader` is required (the operator pins it).
 */
const _trustedProxySchema = z
  .object({
    /** Header the trusted proxy injects with the authenticated user identity. */
    userHeader: z.string().min(1),
    /** Allowlist of users (emails) the gateway will accept from the proxy. */
    allowUsers: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Gateway auth block. The operator only ever emits `trusted-proxy`; the schema
 * still admits the documented modes so the enum stays faithful to OpenClaw.
 */
const _authSchema = z
  .object({
    /** Auth strategy the gateway uses. */
    mode: _authMode,
    /** Trusted-proxy settings, present when `mode === "trusted-proxy"`. */
    trustedProxy: _trustedProxySchema.optional(),
  })
  .strict();

/**
 * PLATFORM-OWNED gateway block. `.strict()` is the load-bearing guarantee: an
 * unknown key here is the exact class of bug that crashed live tenant pods on boot.
 */
const _gatewaySchema = z
  .object({
    /** Gateway run mode. */
    mode: z.enum(["local", "remote"]),
    /** Multiplexed WS+HTTP port. */
    port: z.number().int().positive(),
    /** Network bind scope. */
    bind: _bindMode,
    /** Reverse-proxy source IPs/CIDRs trusted for trusted-proxy auth. */
    trustedProxies: z.array(z.string()),
    /** Delegated-auth configuration. */
    auth: _authSchema,
  })
  .strict();

/**
 * A single model provider entry. INFERRED field set mirrors what the operator
 * emits for the `litellm-proxy` provider (baseUrl/apiKey/api/models).
 */
const _modelProviderSchema = z
  .object({
    /** Provider base URL (e.g. the LiteLLM proxy endpoint). */
    baseUrl: z.string().optional(),
    /** Provider API key, supports `${ENV}` interpolation. */
    apiKey: z.string().optional(),
    /** Wire protocol the provider speaks (e.g. `openai-completions`). */
    api: z.string().optional(),
    /** Allowed model ids; `[]` keeps the proxy default. */
    models: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Models block emitted only when LiteLLM is enabled. `mode` ∈ {merge,replace}
 * (PINNED from docs); `default` is the optional default model id.
 */
const _modelsSchema = z
  .object({
    /** How the provider map merges with built-in providers. */
    mode: z.enum(["merge", "replace"]),
    /** Default model id, surfaced when the control-plane returned one. */
    default: z.string().optional(),
    /** Provider id → provider config map. */
    providers: z.record(z.string(), _modelProviderSchema),
  })
  .strict();

/**
 * Agent defaults the operator pins. INFERRED shape (workspace path + skipBootstrap);
 * `.passthrough()` is deliberate here because a tenant MAY add its own
 * `agents.defaults.*` keys (the operator merges them in step 4 of `_BuildConfigMap`),
 * unlike the strictly platform-owned gateway block.
 */
const _agentsDefaultsSchema = z
  .object({
    /** Persistent workspace path inside the tenant pod. */
    workspace: z.string(),
    /** Skip the interactive bootstrap ritual in the headless pod. */
    skipBootstrap: z.boolean(),
  })
  .passthrough();

/**
 * Agents block. `.passthrough()` mirrors the gateway/agents asymmetry: tenants may
 * extend agents config, so only the platform-pinned `defaults` keys are asserted.
 */
const _agentsSchema = z
  .object({
    /** Default agent settings applied to every agent in the pod. */
    defaults: _agentsDefaultsSchema,
  })
  .passthrough();

/**
 * Top-level `openclaw.json` schema for the operator-emitted config. `.passthrough()`
 * at the root tolerates tenant `configOverrides` adding non-platform top-level keys
 * (which is supported), while the nested `gateway` block stays `.strict()` — exactly
 * the override-can't-clobber-gateway contract C1 enforces.
 */
export const _OpenclawConfigSchema = z
  .object({
    /** Platform-owned gateway block (never overridable by a tenant). */
    gateway: _gatewaySchema,
    /** Optional models block (present only when LiteLLM is enabled). */
    models: _modelsSchema.optional(),
    /** Agents block carrying the platform-pinned defaults. */
    agents: _agentsSchema,
  })
  .passthrough();
