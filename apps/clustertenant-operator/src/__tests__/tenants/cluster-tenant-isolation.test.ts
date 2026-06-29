import { describe, it, expect, beforeEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import pino from "pino";

import { defaultConfig, onPremAdapter, _makeClusterTenant, _makeTenant } from "../fixtures.js";
import { TenantOperator } from "../../tenants/operator.js";
import type { ClusterTenantResource } from "@opencrane/infra-api";

/** Silent logger so test output stays clean. */
const log = pino({ level: "silent" });

/** Records every resource a typed Core/Apps/Networking client is asked to create. */
interface RecordingClient
{
  /** Resources passed to a `createNamespacedX` / `createNamespace` call, in order. */
  created: k8s.KubernetesObject[];
  /** All other API surface is proxied to no-op create methods. */
  [method: string]: unknown;
}

/**
 * Build a recording client that captures the body of every `createX` call and
 * returns it unchanged (simulating a successful create). Any method name
 * starting with `create` records its `body`; `read`/`replace` are unused
 * because every create succeeds.
 */
function _makeRecordingClient(): RecordingClient
{
  const created: k8s.KubernetesObject[] = [];
  return new Proxy(
    { created } as RecordingClient,
    {
      get(target, prop: string): unknown
      {
        if (prop === "created") return target.created;
        // The generic KubernetesObjectApi methods (`create`/`read`/`replace`) must
        // stay absent so `_K8sApplyResource` falls through to the typed switch,
        // which is the production CoreV1/AppsV1 client surface.
        if (prop === "create" || prop === "read" || prop === "replace") return undefined;
        if (typeof prop === "string" && (prop.startsWith("create") || prop.startsWith("replace")))
        {
          return async function record(args: { body?: k8s.KubernetesObject }): Promise<k8s.KubernetesObject | undefined>
          {
            // Only record calls that actually carry a resource body; some typed
            // helpers probe the client surface without one.
            if (args?.body) target.created.push(args.body);
            return args?.body;
          };
        }
        return undefined;
      },
    },
  );
}

/** Build a customApi stub: getClusterCustomObject returns the supplied parent; patchStatus-style calls are no-ops. */
function _makeCustomApi(clusterTenant?: ClusterTenantResource): k8s.CustomObjectsApi
{
  return {
    async getClusterCustomObject(): Promise<unknown>
    {
      if (!clusterTenant) throw new Error("not found");
      return clusterTenant;
    },
    async listNamespacedCustomObject(): Promise<unknown>
    {
      // No AccessPolicies in scope — policy resolution resolves to "no policy".
      return { items: [] };
    },
  } as unknown as k8s.CustomObjectsApi;
}

/**
 * Assemble a TenantOperator wired to recording Core/Apps/Networking clients and
 * a stub customApi. Helper collaborators (status writer, key managers, cleanup)
 * are no-op stubs so the reconcile flow runs end-to-end without a cluster.
 */
function _makeOperator(core: RecordingClient, apps: RecordingClient, networking: RecordingClient,
                       clusterTenant?: ClusterTenantResource, statusSink?: Record<string, unknown>[]): TenantOperator
{
  const customApi = _makeCustomApi(clusterTenant);
  const statusWriter = { async patchStatus(_t: unknown, _ns: unknown, status: Record<string, unknown>): Promise<void> { statusSink?.push(status); } } as never;
  const encryptionKeys = { async ensureEncryptionKeySecret(): Promise<void> {} } as never;
  const liteLlmKeys = { async ensureLiteLlmKeySecret(): Promise<void> {} } as never;
  const cleanup = { async cleanupTenant(): Promise<void> {} } as never;

  return new TenantOperator(
    {} as never,
    customApi,
    core as unknown as k8s.CoreV1Api,
    apps as unknown as k8s.AppsV1Api,
    networking as unknown as k8s.NetworkingV1Api,
    log,
    defaultConfig,
    onPremAdapter,
    cleanup,
    statusWriter,
    encryptionKeys,
    liteLlmKeys,
  );
}

describe("ClusterTenant isolation enforcement (CT.5 reconcile flow)", () =>
{
  let core: RecordingClient;
  let apps: RecordingClient;
  let networking: RecordingClient;

  beforeEach(() =>
  {
    core = _makeRecordingClient();
    apps = _makeRecordingClient();
    networking = _makeRecordingClient();
  });

  it("ref'd openclaw applies PSA namespace + quota + limitrange + scheduling", async () =>
  {
    const clusterTenant = _makeClusterTenant("acme", "ct-acme");
    clusterTenant.spec.compute = { mode: "dedicated", nodePool: "acme-pool" };
    clusterTenant.spec.resources = { quota: { cpu: "4", memory: "8Gi", pods: 10 } };
    const tenant = _makeTenant("mike", { clusterTenantRef: "acme" });

    const operator = _makeOperator(core, apps, networking, clusterTenant);
    await operator.reconcileTenant(tenant);

    // PSA namespace applied with baseline enforce label, in the bound namespace.
    const namespace = core.created.find((r) => r.kind === "Namespace");
    expect(namespace?.metadata?.name).toBe("ct-acme");
    expect(namespace?.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("baseline");

    // ResourceQuota derived from the parent's quota block.
    const quota = core.created.find((r) => r.kind === "ResourceQuota") as k8s.V1ResourceQuota | undefined;
    expect(quota?.metadata?.namespace).toBe("ct-acme");
    expect(quota?.spec?.hard?.["requests.cpu"]).toBe("4");
    expect(quota?.spec?.hard?.pods).toBe("10");

    // LimitRange laid down alongside the quota.
    const limitRange = core.created.find((r) => r.kind === "LimitRange") as k8s.V1LimitRange | undefined;
    expect(limitRange?.metadata?.namespace).toBe("ct-acme");
    expect(limitRange?.spec?.limits?.[0]?.type).toBe("Container");

    // Deployment lands in the bound namespace with dedicated scheduling stamped.
    const deployment = apps.created.find((r) => r.kind === "Deployment") as k8s.V1Deployment | undefined;
    expect(deployment?.metadata?.namespace).toBe("ct-acme");
    const podSpec = deployment?.spec?.template?.spec;
    expect(podSpec?.nodeSelector?.["opencrane.io/node-pool"]).toBe("acme-pool");
    expect(podSpec?.tolerations?.[0]?.key).toBe("opencrane.io/dedicated");
  });

  it("suspending a ref'd openclaw keeps its bound namespace + scheduling, scaled to zero", async () =>
  {
    const clusterTenant = _makeClusterTenant("acme", "ct-acme");
    clusterTenant.spec.compute = { mode: "dedicated", nodePool: "acme-pool" };
    clusterTenant.spec.resources = { quota: { cpu: "4", memory: "8Gi", pods: 10 } };
    const tenant = _makeTenant("mike", { clusterTenantRef: "acme", suspended: true });

    const operator = _makeOperator(core, apps, networking, clusterTenant);
    // suspendTenant is private; the watch dispatcher routes suspended tenants to it.
    await (operator as unknown as { suspendTenant(t: typeof tenant): Promise<void> }).suspendTenant(tenant);

    // The suspended Deployment is rebuilt in the bound namespace with the dedicated
    // scheduling identity intact — not stranded in the CR namespace with no compute.
    const deployment = apps.created.find((r) => r.kind === "Deployment") as k8s.V1Deployment | undefined;
    expect(deployment?.metadata?.namespace).toBe("ct-acme");
    expect(deployment?.spec?.replicas).toBe(0);
    const podSpec = deployment?.spec?.template?.spec;
    expect(podSpec?.nodeSelector?.["opencrane.io/node-pool"]).toBe("acme-pool");
    expect(podSpec?.tolerations?.[0]?.key).toBe("opencrane.io/dedicated");
  });

  it("serves a ref'd openclaw at the ORG host <org>.<base> (no per-user Ingress)", async () =>
  {
    const clusterTenant = _makeClusterTenant("acme", "ct-acme");
    const tenant = _makeTenant("mike", { clusterTenantRef: "acme" });

    const statuses: Record<string, unknown>[] = [];
    const operator = _makeOperator(core, apps, networking, clusterTenant, statuses);
    await operator.reconcileTenant(tenant);

    // No per-user Ingress is minted; the user is served at the org host via the in-operator
    // proxy. The status records the org host (acme.opencrane.local).
    expect(networking.created.some((r) => r.kind === "Ingress")).toBe(false);
    expect(statuses.at(-1)?.ingressHost).toBe("acme.opencrane.local");
  });

  it("serves a ref'd openclaw at the vanity host when a vanity domain is set", async () =>
  {
    const clusterTenant = _makeClusterTenant("acme", "ct-acme");
    clusterTenant.spec.vanityDomain = "ai.client-company.com";
    const tenant = _makeTenant("mike", { clusterTenantRef: "acme" });

    const statuses: Record<string, unknown>[] = [];
    const operator = _makeOperator(core, apps, networking, clusterTenant, statuses);
    await operator.reconcileTenant(tenant);

    expect(statuses.at(-1)?.ingressHost).toBe("ai.client-company.com");
  });

  it("serves a ref-less openclaw at the bare platform base host", async () =>
  {
    const tenant = _makeTenant("plain");

    const statuses: Record<string, unknown>[] = [];
    const operator = _makeOperator(core, apps, networking, undefined, statuses);
    await operator.reconcileTenant(tenant);

    expect(statuses.at(-1)?.ingressHost).toBe("opencrane.local");
  });

  it("default (ref-less) openclaw renders no namespace/quota/limitrange and no scheduling", async () =>
  {
    const tenant = _makeTenant("plain");

    const operator = _makeOperator(core, apps, networking);
    await operator.reconcileTenant(tenant);

    // None of the isolation objects are created on the default path.
    expect(core.created.some((r) => r.kind === "Namespace")).toBe(false);
    expect(core.created.some((r) => r.kind === "ResourceQuota")).toBe(false);
    expect(core.created.some((r) => r.kind === "LimitRange")).toBe(false);

    // The Deployment stays in the install namespace with no scheduling constraints.
    const deployment = apps.created.find((r) => r.kind === "Deployment") as k8s.V1Deployment | undefined;
    expect(deployment?.metadata?.namespace).toBe("default");
    const podSpec = deployment?.spec?.template?.spec;
    expect(podSpec?.nodeSelector).toBeUndefined();
    expect(podSpec?.tolerations).toBeUndefined();
  });
});
