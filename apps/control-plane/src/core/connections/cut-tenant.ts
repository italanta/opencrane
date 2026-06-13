import type * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import type { OpenClawGatewayAdmin } from "./gateway-admin.types.js";
import type { CutTenantParams, CutTenantResult } from "./cut-tenant.types.js";

/**
 * Label selector that matches every pod owned by a tenant.
 * Mirrors `_BuildTenantLabels` in the operator (`opencrane.io/tenant=<name>`).
 */
const TENANT_POD_LABEL = "opencrane.io/tenant";

/**
 * Cut a tenant's brokered OpenClaw connections — the per-user kill-switch (CONN.5).
 *
 * Two layers, applied in order so a revoke is always recorded even if the
 * force-disconnect fails:
 *   1. **Gateway revoke (best-effort)** — ask the pod gateway to revoke device
 *      tokens + pairings so the cut connections cannot re-authenticate. The
 *      default admin is a no-op until a control-plane operator device is paired
 *      (CONN.4), so this half may report `ok: false` — that is expected.
 *   2. **Registry revoke** — mark the BrokeredDevice rows revoked so the
 *      control-plane's view of active connections is accurate.
 *   3. **Kubernetes force-disconnect** — on a *full-tenant* cut, delete the pod
 *      so every established WebSocket is severed immediately. This is
 *      CNI-independent (unlike a deny NetworkPolicy, which only helps if the CNI
 *      drops *established* flows) and is the authoritative cut. A *subject*-scoped
 *      self-serve cut does **not** delete the pod (that would sign out everyone on
 *      the shared per-tenant pod); it relies on the gateway's per-device revoke.
 *
 * @param coreApi      - Kubernetes Core V1 API client (pod deletion).
 * @param prisma       - Prisma client (BrokeredDevice registry).
 * @param gatewayAdmin - Gateway revoke client (live WS path or the no-op default).
 * @param params       - Tenant, namespace, optional subject scope, and reason.
 * @returns A summary of what was revoked and whether the pod was force-deleted.
 */
export async function _CutTenant(coreApi: k8s.CoreV1Api,
                                 prisma: PrismaClient,
                                 gatewayAdmin: OpenClawGatewayAdmin,
                                 params: CutTenantParams): Promise<CutTenantResult>
{
  const scope = params.subject ? "subject" : "tenant";

  // 1. Load the active brokered connections in scope — these tell us which
  //    devices to revoke at the gateway and which registry rows to mark cut.
  const active = await prisma.brokeredDevice.findMany({
    where: {
      tenant: params.tenant,
      revokedAt: null,
      ...(params.subject ? { subject: params.subject } : {}),
    },
    select: { gatewayUrl: true, deviceId: true },
  });

  // 2. Gateway revoke (best-effort) — blocks re-auth of the cut devices. Uses the
  //    gateway URL recorded at broker time; skipped cleanly when nothing is active.
  const gatewayUrl = active[0]?.gatewayUrl;
  const deviceIds = active.map(function _id(row) { return row.deviceId; }).filter(function _present(id): id is string { return id !== null; });
  const gatewayRevoke = gatewayUrl
    ? await gatewayAdmin.revokeConnections({ gatewayUrl, tenant: params.tenant, subject: params.subject, deviceIds })
    : { ok: false, revokedCount: 0, message: "no active brokered connection to revoke" };

  // 3. Registry revoke — mark the in-scope rows cut so the control-plane view of
  //    active connections stays accurate even when the gateway hop is a no-op.
  const revoked = await prisma.brokeredDevice.updateMany({
    where: {
      tenant: params.tenant,
      revokedAt: null,
      ...(params.subject ? { subject: params.subject } : {}),
    },
    data: { revokedAt: new Date() },
  });

  // 4. Kubernetes force-disconnect — only on a full-tenant cut. Deleting the pod
  //    severs every live WebSocket immediately and is CNI-independent; a
  //    subject-scoped self-serve cut must not take down the shared per-tenant pod.
  let podForceDeleted = false;
  if (scope === "tenant")
  {
    await coreApi.deleteCollectionNamespacedPod({
      namespace: params.namespace,
      labelSelector: `${TENANT_POD_LABEL}=${params.tenant}`,
    });
    podForceDeleted = true;
  }

  return {
    tenant: params.tenant,
    scope,
    revokedDevices: revoked.count,
    podForceDeleted,
    gatewayRevoke,
  };
}
