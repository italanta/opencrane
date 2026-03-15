import * as k8s from "@kubernetes/client-node";
import { Hono } from "hono";

import type { CreatePolicyRequest } from "../types.js";

/** Kubernetes API group for OpenCrane custom resources. */
const API_GROUP = "opencrane.io";

/** Kubernetes API version for OpenCrane custom resources. */
const API_VERSION = "v1alpha1";

/** Plural resource name for the AccessPolicy CRD. */
const PLURAL = "accesspolicies";

/**
 * Creates a Hono sub-router that exposes CRUD operations
 * for AccessPolicy custom resources.
 */
export function policiesRouter(customApi: k8s.CustomObjectsApi): Hono
{
  const router = new Hono();
  const namespace = process.env.NAMESPACE ?? "default";

  // List all policies
  router.get("/", async (c) => {
    const result = await customApi.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
    });

    const list = result as { items: Array<{ metadata: { name: string }; spec: Record<string, unknown> }> };
    return c.json(
      list.items.map((item) => ({
        name: item.metadata.name,
        ...item.spec,
      })),
    );
  });

  // Get a single policy
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

      const item = result as { metadata: { name: string }; spec: Record<string, unknown> };
      return c.json({ name: item.metadata.name, ...item.spec });
    } catch {
      return c.json({ error: "Policy not found" }, 404);
    }
  });

  // Create a policy
  router.post("/", async (c) => {
    const body = await c.req.json<CreatePolicyRequest>();

    const policy = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: "AccessPolicy",
      metadata: { name: body.name, namespace },
      spec: {
        description: body.description,
        tenantSelector: body.tenantSelector,
        domains: body.domains,
        egressRules: body.egressRules,
        mcpServers: body.mcpServers,
      },
    };

    await customApi.createNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      body: policy,
    });

    return c.json({ name: body.name, status: "created" }, 201);
  });

  // Update a policy
  router.put("/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<Partial<CreatePolicyRequest>>();

    await customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: { spec: body },
    });

    return c.json({ name, status: "updated" });
  });

  // Delete a policy
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

  return router;
}
