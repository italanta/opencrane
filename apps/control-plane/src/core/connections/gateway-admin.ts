import type { GatewayRevokeParams, GatewayRevokeResult, OpenClawGatewayAdmin } from "./gateway-admin.types.js";

/**
 * Default gateway admin used until a control-plane `operator.pairing` device is
 * paired to tenant pods (CONN.4 — needs live infrastructure to pair and store
 * the device key in a Secret).
 *
 * It performs **no** gateway-side revoke and reports `ok: false` so the
 * kill-switch records that the WS revoke half did not run. This is safe because
 * the kill-switch's authoritative cut is the Kubernetes force-disconnect
 * (pod-delete), which severs established sockets regardless of the gateway hop;
 * the gateway revoke additionally blocks *re-auth* and is wired later.
 */
export class _NoopGatewayAdmin implements OpenClawGatewayAdmin
{
  /**
   * Report that no gateway-side revoke was performed.
   * @param params - Revoke parameters (unused; logged by the caller).
   */
  async revokeConnections(params: GatewayRevokeParams): Promise<GatewayRevokeResult>
  {
    return {
      ok: false,
      revokedCount: 0,
      message: `gateway admin not configured — skipped revoke at ${params.gatewayUrl} (pod-delete still severs live sockets)`,
    };
  }
}

/**
 * Build the gateway admin from the environment.
 *
 * Today this always returns the no-op admin: the live WebSocket revoke path
 * depends on a paired control-plane operator device (CONN.4) that cannot exist
 * without live infrastructure. The factory is the single seam to swap in the
 * real client once that lands, without touching the kill-switch orchestration.
 */
export function _BuildGatewayAdmin(): OpenClawGatewayAdmin
{
  return new _NoopGatewayAdmin();
}
