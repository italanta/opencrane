import type { GatewayRevokeResult } from "./gateway-admin.types.js";

/** Parameters for cutting a tenant's brokered OpenClaw connections (CONN.5). */
export interface CutTenantParams
{
  /** Tenant whose connections are being cut. */
  tenant: string;
  /** Namespace the tenant pod runs in. */
  namespace: string;
  /**
   * When set, cut only this human subject's connections (self-serve "sign out
   * my other sessions"). When omitted, an admin full-tenant cut: every brokered
   * device is revoked **and** the pod is force-deleted to sever live sockets.
   */
  subject?: string;
  /** Free-text reason recorded for audit. */
  reason?: string;
}

/** Outcome of a tenant cut. */
export interface CutTenantResult
{
  /** Tenant that was cut. */
  tenant: string;
  /** Cut scope: whole tenant (admin) or a single subject (self-serve). */
  scope: "tenant" | "subject";
  /** Number of BrokeredDevice registry rows marked revoked. */
  revokedDevices: number;
  /** Whether the tenant pod was force-deleted (only on a full-tenant cut). */
  podForceDeleted: boolean;
  /** Result of the best-effort gateway-side revoke. */
  gatewayRevoke: GatewayRevokeResult;
}
