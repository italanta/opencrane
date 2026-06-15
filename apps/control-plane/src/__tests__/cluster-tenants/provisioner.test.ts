import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClusterTenantComputeMode, ClusterTenantIsolationTier, ClusterTenantPhase } from "@opencrane/contracts";
import type { ClusterTenantProvisionResult } from "@opencrane/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SharedClusterProvisioner } from "../../core/cluster-tenants/shared-cluster.provisioner.js";
import { ExternalWebhookProvisioner } from "../../core/cluster-tenants/external-webhook.provisioner.js";
import { _ReadExternalWebhookConfig } from "../../core/cluster-tenants/external-webhook.config.js";
import { DefaultClusterTenantProvisionerRegistry } from "../../core/cluster-tenants/registry.infra.js";
import { _BuildClusterTenantProvisionerRegistry } from "../../core/cluster-tenants/registry.js";

/** Env keys mutated by these tests, restored after each case. */
const _WEBHOOK_ENV = ["CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL", "CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN", "CLUSTER_TENANT_PROVISIONER_WEBHOOK_ID"];

describe("SharedClusterProvisioner (CT.6 built-in)", function _suite()
{
  it("resolves a shared provision to an opencrane-<name> namespace, ready", async function _sharedReady()
  {
    const provisioner = new SharedClusterProvisioner();
    const result = await provisioner.provision({
      name: "acme",
      isolationTier: ClusterTenantIsolationTier.Shared,
      compute: { mode: ClusterTenantComputeMode.Shared },
      quota: { cpu: "4", memory: "8Gi" },
    });

    expect(result.phase).toBe(ClusterTenantPhase.Ready);
    expect(result.boundNamespace).toBe("opencrane-acme");
    expect(result.kubeconfigSecretRef).toBeUndefined();
    expect(await provisioner.getKubeconfigRef("acme")).toBeNull();
  });
});

describe("ExternalWebhookProvisioner (CT.6 arm's-length delegation)", function _suite()
{
  const _servers: ReturnType<typeof createServer>[] = [];

  afterEach(function _cleanup()
  {
    for (const server of _servers.splice(0))
    {
      server.close();
    }
  });

  it("POSTs a provision request to the configured endpoint and reads back the result", async function _externalProvision()
  {
    // 1. Stand up a local HTTP stub standing in for the out-of-process backend,
    //    asserting the request shape and replying with a kubeconfig Secret ref.
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const reply: ClusterTenantProvisionResult = {
      phase: ClusterTenantPhase.Ready,
      boundNamespace: "ext-acme",
      kubeconfigSecretRef: "kubeconfig-acme",
    };
    const server = createServer(function _handler(req, res)
    {
      seenAuth = req.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      req.on("data", function _onData(chunk) { chunks.push(chunk as Buffer); });
      req.on("end", function _onEnd()
      {
        seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    _servers.push(server);
    await new Promise<void>(function _listen(resolve) { server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as AddressInfo).port;

    // 2. Drive the external provisioner against the stub over real HTTP.
    const provisioner = new ExternalWebhookProvisioner({ url: `http://127.0.0.1:${port}`, token: "secret-token", id: "external" });
    const result = await provisioner.provision({
      name: "acme",
      isolationTier: ClusterTenantIsolationTier.DedicatedCluster,
      compute: { mode: ClusterTenantComputeMode.Dedicated, nodePool: "acme-pool" },
      quota: { cpu: "16", memory: "64Gi" },
    });

    // 3. Confirm the bearer token, the vendor-neutral body, and the kubeconfig
    //    reference (never inline material) round-tripped correctly.
    expect(seenAuth).toBe("Bearer secret-token");
    expect(seenBody).toMatchObject({ name: "acme", isolationTier: "dedicatedCluster" });
    expect(result.phase).toBe(ClusterTenantPhase.Ready);
    expect(result.kubeconfigSecretRef).toBe("kubeconfig-acme");
    expect(await provisioner.getKubeconfigRef("acme")).toBe("kubeconfig-acme");
  });
});

describe("DefaultClusterTenantProvisionerRegistry (CT.6 routing)", function _suite()
{
  const _saved: Record<string, string | undefined> = {};

  afterEach(function _restore()
  {
    for (const key of _WEBHOOK_ENV)
    {
      if (_saved[key] === undefined)
      {
        delete process.env[key];
      }
      else
      {
        process.env[key] = _saved[key];
      }
    }
  });

  it("reports dedicatedCluster unavailable when no webhook is configured", function _noWebhook()
  {
    for (const key of _WEBHOOK_ENV)
    {
      _saved[key] = process.env[key];
      delete process.env[key];
    }

    const registry = _BuildClusterTenantProvisionerRegistry();
    expect(registry.isTierAvailable(ClusterTenantIsolationTier.Shared)).toBe(true);
    expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedNodes)).toBe(true);
    expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedCluster)).toBe(false);
    expect(registry.capabilities().map(c => c.id)).toEqual(["shared"]);
  });

  it("reports dedicatedCluster available when the webhook is configured", function _withWebhook()
  {
    for (const key of _WEBHOOK_ENV)
    {
      _saved[key] = process.env[key];
    }
    process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL = "https://provisioner.example/api";
    process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN = "token";
    delete process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_ID;

    const registry = _BuildClusterTenantProvisionerRegistry();
    expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedCluster)).toBe(true);
    expect(registry.provisionerFor(ClusterTenantIsolationTier.DedicatedCluster)).toBeInstanceOf(ExternalWebhookProvisioner);
    expect(registry.provisionerFor(ClusterTenantIsolationTier.Shared)).toBeInstanceOf(SharedClusterProvisioner);
  });

  it("routes a tier to null when the registry holds no matching backend", function _emptyRegistry()
  {
    const registry = new DefaultClusterTenantProvisionerRegistry([]);
    expect(registry.isTierAvailable(ClusterTenantIsolationTier.Shared)).toBe(false);
    expect(registry.provisionerFor(ClusterTenantIsolationTier.Shared)).toBeNull();
  });

  it("refuses a non-HTTPS webhook URL so the bearer token is never sent in plaintext", function _rejectPlaintext()
  {
    for (const key of _WEBHOOK_ENV)
    {
      _saved[key] = process.env[key];
    }
    process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL = "http://provisioner.example/api";
    process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN = "token";

    expect(function _load() { _ReadExternalWebhookConfig(); }).toThrow(/https:\/\//);
  });

  // NO-VENDOR ASSERTION (CT.6): the provisioner seam must carry no vendor names.
  // A repo-level grep proves it: from apps/control-plane run
  //   grep -ri -E 'kamaji|vcluster|capi|clusterapi' src/core/cluster-tenants
  // and expect zero matches. Kept as a comment so the test file itself stays clean.
});
