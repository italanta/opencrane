import { Hono } from "hono";
import * as k8s from "@kubernetes/client-node";
import type { CreateTenantRequest, TenantResponse } from "../types.js";

const API_GROUP = "opencrane.io";
const API_VERSION = "v1alpha1";
const PLURAL = "tenants";

export function tenantsRouter(customApi: k8s.CustomObjectsApi): Hono {
  const router = new Hono();
  const namespace = process.env.NAMESPACE ?? "default";

  // List all tenants
  router.get("/", async (c) => {
    const result = await customApi.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
    });

    const list = result as { items: Array<{ metadata: { name: string; creationTimestamp?: string }; spec: Record<string, unknown>; status?: Record<string, unknown> }> };
    const tenants: TenantResponse[] = list.items.map((item) => ({
      name: item.metadata.name,
      displayName: item.spec.displayName as string,
      email: item.spec.email as string,
      team: item.spec.team as string | undefined,
      phase: (item.status?.phase as string) ?? "Pending",
      ingressHost: item.status?.ingressHost as string | undefined,
      createdAt: item.metadata.creationTimestamp,
    }));

    return c.json(tenants);
  });

  // Get a single tenant
  router.get("/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const result = await customApi.getNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
      });

      const item = result as { metadata: { name: string; creationTimestamp?: string }; spec: Record<string, unknown>; status?: Record<string, unknown> };
      const tenant: TenantResponse = {
        name: item.metadata.name,
        displayName: item.spec.displayName as string,
        email: item.spec.email as string,
        team: item.spec.team as string | undefined,
        phase: (item.status?.phase as string) ?? "Pending",
        ingressHost: item.status?.ingressHost as string | undefined,
        createdAt: item.metadata.creationTimestamp,
      };

      return c.json(tenant);
    } catch {
      return c.json({ error: "Tenant not found" }, 404);
    }
  });

  // Create a tenant
  router.post("/", async (c) => {
    const body = await c.req.json<CreateTenantRequest>();

    const tenant = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: "Tenant",
      metadata: { name: body.name, namespace },
      spec: {
        displayName: body.displayName,
        email: body.email,
        team: body.team,
        resources: body.resources,
        skills: body.skills,
        policyRef: body.policyRef,
      },
    };

    await customApi.createNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      body: tenant,
    });

    return c.json({ name: body.name, status: "created" }, 201);
  });

  // Update a tenant
  router.put("/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<Partial<CreateTenantRequest>>();

    const patch = {
      spec: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.team ? { team: body.team } : {}),
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.skills ? { skills: body.skills } : {}),
        ...(body.policyRef ? { policyRef: body.policyRef } : {}),
      },
    };

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: patch,
    });

    return c.json({ name, status: "updated" });
  });

  // Delete a tenant
  router.delete("/:name", async (c) => {
    const name = c.req.param("name");

    await customApi.deleteNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
    });

    return c.json({ name, status: "deleted" });
  });

  // Suspend/resume a tenant
  router.post("/:name/suspend", async (c) => {
    const name = c.req.param("name");

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: { spec: { suspended: true } },
    });

    return c.json({ name, status: "suspended" });
  });

  router.post("/:name/resume", async (c) => {
    const name = c.req.param("name");

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: { spec: { suspended: false } },
    });

    return c.json({ name, status: "resumed" });
  });

  return router;
}
