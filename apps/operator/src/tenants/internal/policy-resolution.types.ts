import { TenantPolicyResolutionState } from "../models/tenant-status.interface.js";

/** Result payload for deterministic tenant policy resolution. */
export interface TenantPolicyResolutionResult
{
  /** Effective policy name applied to the tenant, when one is found. */
  effectivePolicyRef?: string;

  /** Resolution source used to pick the effective policy. */
  source: "policyRef" | "selector" | "default" | "none";

  /** Resolution outcome state used for status and error handling. */
  state: TenantPolicyResolutionState;

  /** Human-readable message for status and logs. */
  message: string;
}