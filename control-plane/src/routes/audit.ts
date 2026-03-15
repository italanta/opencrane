import * as k8s from "@kubernetes/client-node";
import { Hono } from "hono";

import type { AuditEntry } from "../types.js";

/**
 * Creates a Hono sub-router that queries Kubernetes events
 * for OpenCrane resources and returns them as audit log entries.
 */
export function auditRouter(coreApi: k8s.CoreV1Api): Hono
{
  const router = new Hono();
  const namespace = process.env.NAMESPACE ?? "default";

  // Query audit log (Kubernetes events for opencrane resources)
  router.get("/", async (c) => {
    const tenant = c.req.query("tenant");
    const limit = Number(c.req.query("limit") ?? "100");

    const result = await coreApi.listNamespacedEvent({
      namespace,
      fieldSelector: "involvedObject.apiVersion=opencrane.io/v1alpha1",
      limit,
    });

    let entries: AuditEntry[] = result.items.map((event) => ({
      timestamp: event.lastTimestamp?.toISOString() ?? event.metadata.creationTimestamp?.toISOString() ?? "",
      tenant: event.involvedObject.name,
      action: event.reason ?? "Unknown",
      resource: `${event.involvedObject.kind}/${event.involvedObject.name}`,
      message: event.message ?? "",
    }));

    // Filter by tenant if specified
    if (tenant) {
      entries = entries.filter((e) => e.tenant === tenant);
    }

    // Sort newest first
    entries.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return c.json(entries);
  });

  return router;
}
