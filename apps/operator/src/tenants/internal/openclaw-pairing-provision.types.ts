/**
 * An OpenClaw pairing link decoded from a pod's setup code (CONN.3).
 *
 * The setup code emitted by `openclaw qr --setup-code-only` is base64 of a JSON
 * `{ url, bootstrapToken }` — the same shape the control-plane broker hands the
 * browser. The operator captures this after provisioning a pod and persists it
 * via the control-plane `PUT /tenants/:name/pairing` endpoint.
 */
export interface OpenClawPairingLink
{
  /** The gateway URL the pod advertises (decoded from `url`). */
  gatewayUrl?: string;
  /** The short-lived single-use bootstrap token for the pairing handshake. */
  bootstrapToken: string;
}
