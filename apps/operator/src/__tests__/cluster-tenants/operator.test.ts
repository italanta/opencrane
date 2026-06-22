import { describe, it, expect, vi, beforeEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import pino from "pino";

import { defaultConfig, _makeClusterTenant } from "../fixtures.js";
import { ClusterTenantOperator } from "../../cluster-tenants/operator.js";
import { ClusterTenantStatusWriter } from "../../cluster-tenants/internal/cluster-tenant-status-writer.js";
import type { OrgDomainProvisioner, OrgDomainProvisionRequest, OrgDomainProvisionResult } from "../../cluster-tenants/internal/org-domain-provisioner.types.js";
import type { ClusterTenantResource } from "../../tenants/internal/cluster-tenant-resolution.types.js";

const log = pino({ level: "silent" });

/** Recorded status-patch body so a test can read what the reconciler stamped. */
type StatusPatch = Record<string, unknown>;

/**
 * Build a stub CustomObjectsApi that records the merged status value from each
 * `patchClusterCustomObjectStatus` call (JSON Patch `add /status`), plus a spy.
 */
function _makeStubCustomApi(): { api: k8s.CustomObjectsApi; patches: StatusPatch[]; spy: ReturnType<typeof vi.fn> }
{
  const patches: StatusPatch[] = [];
  const spy = vi.fn(async function _patch(args: { body: Array<{ value: StatusPatch }> })
  {
    patches.push(args.body[0].value);
  });
  const api = { patchClusterCustomObjectStatus: spy } as unknown as k8s.CustomObjectsApi;
  return { api, patches, spy };
}

/**
 * Build a stub CoreV1Api whose namespace create succeeds, recording each created
 * namespace name so a test can assert the boundary was fenced.
 */
function _makeStubCoreApi(): { api: k8s.CoreV1Api; createdNamespaces: string[] }
{
  const createdNamespaces: string[] = [];
  const api = {
    createNamespace: vi.fn(async function _createNs(args: { body: k8s.V1Namespace }) {
      createdNamespaces.push(args.body.metadata!.name!);
      return args.body;
    }),
  } as unknown as k8s.CoreV1Api;
  return { api, createdNamespaces };
}

/** A single recorded `deprovisionOrgDomain` invocation. */
interface DeprovisionCall { orgName: string; platformBaseDomain: string; boundNamespace: string }

/** A domain provisioner whose result and invocations a test controls. */
function _makeDomainProvisioner(result: Partial<OrgDomainProvisionResult>, deprovisionImpl?: () => Promise<void>): { provisioner: OrgDomainProvisioner; calls: OrgDomainProvisionRequest[]; deprovisions: DeprovisionCall[] }
{
  const calls: OrgDomainProvisionRequest[] = [];
  const deprovisions: DeprovisionCall[] = [];
  const provisioner: OrgDomainProvisioner = {
    async provisionOrgDomain(req: OrgDomainProvisionRequest): Promise<OrgDomainProvisionResult>
    {
      calls.push(req);
      return {
        orgDomain: `${req.orgName}.${req.platformBaseDomain}`,
        ready: false,
        skipped: true,
        ...result,
      };
    },
    async deprovisionOrgDomain(orgName: string, platformBaseDomain: string, boundNamespace: string): Promise<void>
    {
      deprovisions.push({ orgName, platformBaseDomain, boundNamespace });
      if (deprovisionImpl) await deprovisionImpl();
    },
  };
  return { provisioner, calls, deprovisions };
}

/** Cast helper to drive the operator's private watch-event handler in a test. */
function _emit(operator: ClusterTenantOperator, type: string, ct: ClusterTenantResource): Promise<void>
{
  return (operator as unknown as { handleEvent(t: string, c: ClusterTenantResource): Promise<void> }).handleEvent(type, ct);
}

/** Assemble a ClusterTenantOperator over the supplied stubs. */
function _buildOperator(customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api, domain: OrgDomainProvisioner): ClusterTenantOperator
{
  const statusWriter = new ClusterTenantStatusWriter(customApi, log);
  const watch = {} as k8s.Watch;
  return new ClusterTenantOperator(watch, customApi, coreApi, statusWriter, domain, defaultConfig, log);
}

describe("ClusterTenantOperator.reconcile", () =>
{
  beforeEach(() => vi.clearAllMocks());

  it("drives a pending org to ready, stamping phase + boundNamespace", async () =>
  {
    const { api: customApi, patches } = _makeStubCustomApi();
    const { api: coreApi, createdNamespaces } = _makeStubCoreApi();
    const { provisioner } = _makeDomainProvisioner({ skipped: true, ready: false });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await operator.reconcile(_makeClusterTenant("acme")); // no status → pending

    const last = patches.at(-1)!;
    expect(last.phase).toBe("ready");
    expect(last.boundNamespace).toBe("opencrane-acme");
    expect(last.provisioner).toBe("shared");
    // Transitional provisioning phase was written first, then ready.
    expect(patches.some((p) => p.phase === "provisioning")).toBe(true);
    // The bound namespace was fenced.
    expect(createdNamespaces).toContain("opencrane-acme");
  });

  it("is idempotent: re-reconciling a ready org converges without a provisioning churn", async () =>
  {
    const { api: customApi, patches } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner } = _makeDomainProvisioner({ skipped: true, ready: false });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    const alreadyReady = _makeClusterTenant("acme", "opencrane-acme"); // status.phase = ready
    await operator.reconcile(alreadyReady);

    // Already-ready org must not be flipped back through `provisioning`.
    expect(patches.some((p) => p.phase === "provisioning")).toBe(false);
    // It still converges to ready with the same bound namespace.
    expect(patches.at(-1)!.phase).toBe("ready");
    expect(patches.at(-1)!.boundNamespace).toBe("opencrane-acme");
  });

  it("invokes the OrgDomainProvisioner with the org's coordinates", async () =>
  {
    const { api: customApi } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner, calls } = _makeDomainProvisioner({ skipped: false, ready: true, tlsSecretName: "tls" });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await operator.reconcile(_makeClusterTenant("acme"));

    expect(calls).toHaveLength(1);
    expect(calls[0].orgName).toBe("acme");
    expect(calls[0].platformBaseDomain).toBe(defaultConfig.ingressDomain);
  });

  it("reaches ready and records the skip when the domain provisioner is unavailable", async () =>
  {
    const { api: customApi, patches } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner } = _makeDomainProvisioner({ skipped: true, ready: false });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await operator.reconcile(_makeClusterTenant("acme"));

    const last = patches.at(-1)!;
    // The org still reaches ready — the namespace boundary is the attachment gate.
    expect(last.phase).toBe("ready");
    expect(last.domainSkipped).toBe(true);
    expect(last.domainReady).toBe(false);
  });

  it("marks failed (no throw) for an isolation tier no in-cluster provisioner serves", async () =>
  {
    const { api: customApi, patches } = _makeStubCustomApi();
    const { api: coreApi, createdNamespaces } = _makeStubCoreApi();
    const { provisioner, calls } = _makeDomainProvisioner({ skipped: true });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    const ct = _makeClusterTenant("bigco");
    ct.spec.isolationTier = "dedicatedCluster";
    await operator.reconcile(ct);

    expect(patches.at(-1)!.phase).toBe("failed");
    // No namespace fenced and the domain hook never ran for a failed boundary.
    expect(createdNamespaces).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("marks failed and re-throws when namespace fencing errors", async () =>
  {
    const { api: customApi, patches } = _makeStubCustomApi();
    const coreApi = {
      createNamespace: vi.fn(async function _boom() { throw new Error("apiserver down"); }),
    } as unknown as k8s.CoreV1Api;
    const { provisioner } = _makeDomainProvisioner({ skipped: true });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await expect(operator.reconcile(_makeClusterTenant("acme"))).rejects.toThrow(/apiserver down/);
    expect(patches.at(-1)!.phase).toBe("failed");
    expect(patches.at(-1)!.message).toMatch(/apiserver down/);
  });
});

describe("ClusterTenantOperator delete handling (DOMAIN.T2)", () =>
{
  beforeEach(() => vi.clearAllMocks());

  it("deprovisions the per-org domain on a DELETED event, using status.boundNamespace", async () =>
  {
    const { api: customApi } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner, deprovisions } = _makeDomainProvisioner({ skipped: true });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await _emit(operator, "DELETED", _makeClusterTenant("acme", "opencrane-acme"));

    expect(deprovisions).toHaveLength(1);
    expect(deprovisions[0].orgName).toBe("acme");
    expect(deprovisions[0].boundNamespace).toBe("opencrane-acme");
    expect(deprovisions[0].platformBaseDomain).toBe(defaultConfig.ingressDomain);
  });

  it("re-derives the bound namespace deterministically when status is already stripped", async () =>
  {
    const { api: customApi } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner, deprovisions } = _makeDomainProvisioner({ skipped: true });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    // No boundNamespace in status (deletion races can strip it) → falls back to opencrane-<name>.
    await _emit(operator, "DELETED", _makeClusterTenant("acme"));

    expect(deprovisions).toHaveLength(1);
    expect(deprovisions[0].boundNamespace).toBe("opencrane-acme");
  });

  it("swallows a deprovision error (no throw) so a teardown failure cannot wedge the watch loop", async () =>
  {
    const { api: customApi } = _makeStubCustomApi();
    const { api: coreApi } = _makeStubCoreApi();
    const { provisioner } = _makeDomainProvisioner({ skipped: true }, async () => { throw new Error("apiserver down"); });
    const operator = _buildOperator(customApi, coreApi, provisioner);

    await expect(_emit(operator, "DELETED", _makeClusterTenant("acme", "opencrane-acme"))).resolves.toBeUndefined();
  });
});
