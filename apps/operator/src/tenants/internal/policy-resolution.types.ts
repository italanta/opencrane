import type { AccessPolicy } from "../../policies/types.js";
import { TenantPolicyResolutionState } from "../models/tenant-status.interface.js";

/** Result payload for deterministic tenant policy resolution. */
export interface TenantPolicyResolutionResult
{
  /** Effective policy resource resolved for this tenant, when one is found. */
  effectivePolicy?: AccessPolicy;

  /** Resolution source used to pick the effective policy. */
  source: "policyRef" | "selector" | "default" | "none";

  /** Resolution outcome state used for status and error handling. */
  state: TenantPolicyResolutionState;

  /** Human-readable message for status and logs. */
  message: string;
}