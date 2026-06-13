/** Parameters for recording a brokered OpenClaw connection (CONN.4). */
export interface RecordBrokeredDeviceParams
{
  /** Tenant whose pod gateway the connection was brokered to. */
  tenant: string;
  /** IdP-verified human identity the connection was brokered for (OIDC sub, else email). */
  subject: string;
  /** The `wss://` gateway URL handed to the caller at broker time. */
  gatewayUrl: string;
}
