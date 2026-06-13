import type { PrismaClient } from "@prisma/client";

import type { RecordBrokeredDeviceParams } from "./brokered-device.types.js";

/**
 * Record (or refresh) a brokered OpenClaw connection in the device registry.
 *
 * Called on every successful `/auth/pod-token` broker so the per-user
 * kill-switch (`_CutTenant`, CONN.5) has an authoritative list of which
 * (tenant, subject) connections to revoke. Re-brokering an existing
 * (tenant, subject) bumps `lastBrokeredAt` and clears any prior `revokedAt`
 * — re-issuing a pairing link reactivates the connection record.
 *
 * Best-effort: the caller treats a failure here as non-fatal (the broker
 * still returns the pairing link). The control plane stays connection-
 * stateless, so this row is bookkeeping for revocation, not a gate on connect.
 *
 * @param prisma - Prisma client.
 * @param params - Tenant, subject, and the brokered gateway URL.
 */
export async function _RecordBrokeredDevice(prisma: PrismaClient, params: RecordBrokeredDeviceParams): Promise<void>
{
  await prisma.brokeredDevice.upsert({
    where: { tenant_subject: { tenant: params.tenant, subject: params.subject } },
    create: {
      tenant: params.tenant,
      subject: params.subject,
      gatewayUrl: params.gatewayUrl,
    },
    update: {
      gatewayUrl: params.gatewayUrl,
      revokedAt: null,
    },
  });
}
