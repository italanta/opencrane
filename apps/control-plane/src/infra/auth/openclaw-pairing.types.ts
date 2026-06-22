/**
 * Resolved OpenClaw connection coordinates for a tenant pod.
 *
 * Under trusted-proxy gateway auth (CONN.4) the browser holds no credential —
 * the identity-routing gateway proxy authorises the socket against the live OIDC
 * session (`/auth/gateway-resolve`), so only the gateway URL is needed to connect.
 */
export interface OpenClawPairing
{
  /** Gateway WebSocket URL (`wss://…`) the browser connects to. */
  gatewayUrl: string;
}
