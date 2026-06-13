/**
 * Parameters for revoking brokered connections at a tenant's OpenClaw gateway.
 *
 * The live implementation connects to the gateway as the control-plane-held
 * `operator.pairing` device (CONN.4) and calls `device.token.revoke` +
 * `device.pair.remove`. That WebSocket handshake is the live-infra seam.
 */
export interface GatewayRevokeParams
{
  /** The `wss://` gateway URL to connect to. */
  gatewayUrl: string;
  /** Tenant whose connections are being revoked (for logging/audit context). */
  tenant: string;
  /**
   * When set, revoke only this human subject's devices (self-serve "sign out my
   * other sessions"). When omitted, revoke every brokered device for the tenant.
   */
  subject?: string;
  /** Known OpenClaw device ids to target, when the registry has captured them. */
  deviceIds?: string[];
}

/** Outcome of a gateway revoke attempt. */
export interface GatewayRevokeResult
{
  /** True when the gateway acknowledged the revoke; false when it could not run. */
  ok: boolean;
  /** Number of device tokens/pairings the gateway reported revoked. */
  revokedCount: number;
  /** Human-readable detail — why a revoke was skipped, or a gateway error message. */
  message?: string;
}

/**
 * Revokes brokered credentials at an OpenClaw pod gateway.
 *
 * Abstracts the live WebSocket admin path (`device.token.revoke` /
 * `device.pair.remove`) so the kill-switch orchestration is unit-testable
 * against a mock and the production WS client can be wired in once a
 * control-plane operator device is paired (CONN.4, needs live infra).
 */
export interface OpenClawGatewayAdmin
{
  /**
   * Revoke device tokens and pairings at the gateway.
   * @param params - Gateway URL, tenant, and optional subject/device scope.
   */
  revokeConnections(params: GatewayRevokeParams): Promise<GatewayRevokeResult>;
}
