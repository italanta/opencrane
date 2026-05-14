import type * as k8s from "@kubernetes/client-node";

import type { OpenClawTenantOperatorConfig } from "../../config.js";
import type { AccessPolicy } from "../../policies/types.js";
import { ACCESS_POLICY_CRD_PLURAL, OPENCRANE_API_GROUP, OPENCRANE_API_VERSION } from "../../shared/crd-constants.js";
import type { Tenant } from "../models/tenant.interface.js";
import type { TenantPolicyResolutionResult } from "./policy-resolution.types.js";
import { TenantPolicyResolutionState } from "../models/tenant-status.interface.js";

/**
 * Resolve a tenant's effective AccessPolicy deterministically.
 *
 * Precedence:
 * 1) Explicit `Tenant.spec.policyRef`
 * 2) Exactly one selector match
 * 3) Optional configured default policy
 * 4) No policy
 */
export async function _ResolveTenantPolicy(customApi: k8s.CustomObjectsApi, config: OpenClawTenantOperatorConfig,
                                           tenant: Tenant, namespace: string): Promise<TenantPolicyResolutionResult>
{
  const policyListResponse 
    = await customApi.listNamespacedCustomObject({
        group: OPENCRANE_API_GROUP,
        version: OPENCRANE_API_VERSION,
        namespace,
        plural: ACCESS_POLICY_CRD_PLURAL,
      }) as { body?: { items?: AccessPolicy[] } };

  const policies = policyListResponse.body?.items ?? [];
  const policiesByName = new Map(policies.map(function _toPolicyEntry(policy)
  {
    return [policy.metadata?.name ?? "", policy] as const;
  }));

  // 1. Explicit policyRef has highest priority and must resolve to an existing policy.
  if (tenant.spec.policyRef)
  {
    const explicitPolicy = policiesByName.get(tenant.spec.policyRef);
    if (!explicitPolicy)
    {
      return {
        source: "policyRef",
        state: TenantPolicyResolutionState.PolicyNotFound,
        message: `policyRef '${tenant.spec.policyRef}' was not found`,
      };
    }

    return {
      effectivePolicyRef: tenant.spec.policyRef,
      source: "policyRef",
      state: TenantPolicyResolutionState.Resolved,
      message: `policyRef '${tenant.spec.policyRef}' resolved`,
    };
  }

  // 2. Selector fallback applies only when exactly one policy matches this tenant.
  const selectorMatches = policies.filter(function _isSelectorMatch(policy)
  {
    return _PolicyMatchesTenant(policy, tenant);
  });

  if (selectorMatches.length > 1)
  {
    const conflictNames = selectorMatches
      .map(function _mapName(policy)
      {
        return policy.metadata?.name ?? "";
      })
      .filter(function _hasName(name)
      {
        return name.length > 0;
      })
      .sort();

    return {
      source: "selector",
      state: TenantPolicyResolutionState.PolicyConflict,
      message: `multiple selector policies matched: ${conflictNames.join(", ")}`,
    };
  }

  if (selectorMatches.length === 1)
  {
    const matchName = selectorMatches[0].metadata?.name;
    return {
      effectivePolicyRef: matchName,
      source: "selector",
      state: TenantPolicyResolutionState.Resolved,
      message: `selector policy '${matchName}' resolved`,
    };
  }

  // 3. Default policy is optional and used only when no explicit or selector match exists.
  if (config.defaultTenantPolicyRef)
  {
    const defaultPolicy = policiesByName.get(config.defaultTenantPolicyRef);
    if (!defaultPolicy)
    {
      return {
        source: "default",
        state: TenantPolicyResolutionState.DefaultPolicyNotFound,
        message: `default policy '${config.defaultTenantPolicyRef}' was not found`,
      };
    }

    return {
      effectivePolicyRef: config.defaultTenantPolicyRef,
      source: "default",
      state: TenantPolicyResolutionState.Resolved,
      message: `default policy '${config.defaultTenantPolicyRef}' resolved`,
    };
  }

  return {
    source: "none",
    state: TenantPolicyResolutionState.NoPolicy,
    message: "no explicit, selector, or default policy matched",
  };
}

/**
 * Check whether an AccessPolicy selector matches a tenant.
 */
function _PolicyMatchesTenant(policy: AccessPolicy, tenant: Tenant): boolean
{
  const selector = policy.spec.tenantSelector;
  if (!selector)
  {
    return false;
  }

  const hasLabelSelector = Object.keys(selector.matchLabels ?? {}).length > 0;
  const hasTeamSelector = !!selector.matchTeam;
  if (!hasLabelSelector && !hasTeamSelector)
  {
    return false;
  }

  if (selector.matchTeam && selector.matchTeam !== tenant.spec.team)
  {
    return false;
  }

  const tenantLabels: Record<string, string | undefined> = {
    ...(tenant.metadata?.labels ?? {}),
    ...(tenant.metadata?.name ? { "opencrane.io/tenant": tenant.metadata.name } : {}),
    ...(tenant.spec.team ? { "opencrane.io/team": tenant.spec.team } : {}),
  };

  const matchLabels = selector.matchLabels ?? {};
  return Object.entries(matchLabels).every(function _labelsMatch([key, value])
  {
    return tenantLabels[key] === value;
  });
}