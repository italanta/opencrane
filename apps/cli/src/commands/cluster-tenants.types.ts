/**
 * Shared option/payload shapes for the `oc cluster-tenant` command group.
 *
 * Kept in a sibling `*.types.ts` file per the repository TypeScript guidance:
 * exported interfaces and type aliases must not live in the implementation file.
 */

import type { OutputFormat } from "../format.js";

/** Quota flag values shared by the create and update sub-commands. */
export interface ClusterTenantQuotaOptions
{
  /** Total CPU the customer may request (e.g. "4", "500m"). */
  quotaCpu?: string;
  /** Total memory the customer may request (e.g. "8Gi"). */
  quotaMemory?: string;
  /** Maximum number of pods the customer may run (parsed to a number). */
  quotaPods?: string;
  /** Total persistent storage the customer may claim (e.g. "100Gi"). */
  quotaStorage?: string;
  /** Total GPUs the customer may request (parsed to a number). */
  quotaGpu?: string;
}

/** Flag values accepted by `oc cluster-tenant create`. */
export interface ClusterTenantCreateOptions extends ClusterTenantQuotaOptions
{
  /** Human-readable customer name. */
  displayName: string;
  /** Optional customer-vanity domain CNAMEd onto the org apex (e.g. ai.client-company.com). */
  vanityDomain?: string;
  /** Isolation strength: shared | dedicatedNodes | dedicatedCluster. */
  tier: string;
  /** Compute placement mode: shared | dedicated. */
  compute: string;
  /** Dedicated node pool name (required when --compute dedicated). */
  nodePool?: string;
  /** Output format: table | json. */
  output: OutputFormat;
}

/** Flag values accepted by `oc cluster-tenant update`. */
export interface ClusterTenantUpdateOptions extends ClusterTenantQuotaOptions
{
  /** New human-readable customer name. */
  displayName?: string;
  /** New customer-vanity domain CNAMEd onto the org apex (empty string clears it). */
  vanityDomain?: string;
  /** New isolation tier: shared | dedicatedNodes | dedicatedCluster. */
  tier?: string;
  /** New compute placement mode: shared | dedicated. */
  compute?: string;
  /** New dedicated node pool name. */
  nodePool?: string;
  /** Output format: table | json. */
  output: OutputFormat;
}

/** Resource-quota body block built from the quota flags. */
export interface ClusterTenantQuotaBody
{
  /** Total CPU the customer may request. */
  cpu?: string;
  /** Total memory the customer may request. */
  memory?: string;
  /** Maximum number of pods the customer may run. */
  pods?: number;
  /** Total persistent storage the customer may claim. */
  storage?: string;
  /** Total GPUs the customer may request. */
  gpu?: number;
}
