import type * as k8s from "@kubernetes/client-node";

import type { Tenant } from "../../models/tenant.interface.js";

/** Candidate tenant for idle-suspend evaluation. */
export interface IdleCandidate
{
  /** Tenant resource name. */
  name: string;

  /** Tenant namespace. */
  namespace: string;
}

/**
 * Return only running, non-suspended tenants that can be evaluated for idleness.
 */
export function _ListIdleCandidates(tenants: Tenant[]): IdleCandidate[]
{
  return tenants
    .filter((tenant) => Boolean(tenant.metadata?.name))
    .filter((tenant) => !tenant.spec.suspended)
    .filter((tenant) => tenant.status?.phase === "Running")
    .map((tenant) => ({
      name: tenant.metadata!.name!,
      namespace: tenant.metadata?.namespace ?? "default",
    }));
}

/**
 * Compute the most recent transition timestamp across deployment conditions.
 */
export function _ComputeLastActivityMs(conditions: k8s.V1DeploymentCondition[] | undefined): number
{
  let lastActivity = 0;

  for (const condition of conditions ?? [])
  {
    const transitionTime = condition.lastTransitionTime
      ? new Date(condition.lastTransitionTime as unknown as string).getTime()
      : 0;

    if (transitionTime > lastActivity)
    {
      lastActivity = transitionTime;
    }
  }

  return lastActivity;
}

/**
 * Determine if the tenant should be auto-suspended based on idle threshold.
 */
export function _ShouldSuspend(nowMs: number, lastActivityMs: number, thresholdMs: number): boolean
{
  if (lastActivityMs === 0) return false;
  return (nowMs - lastActivityMs) > thresholdMs;
}
