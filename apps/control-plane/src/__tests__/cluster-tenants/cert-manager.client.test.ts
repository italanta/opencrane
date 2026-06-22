import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import { CertManagerClient } from "../../core/cluster-tenants/cert-manager.client.js";

/** A 404 error matching the client's not-found / CRD-absent shape. */
const _NOT_FOUND = Object.assign(new Error("not found"), { code: 404 });
/** A 409 error matching the client's conflict shape. */
const _CONFLICT = Object.assign(new Error("already exists"), { code: 409 });

const _MANIFEST = { apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: { name: "org-wildcard-tls-acme", namespace: "opencrane-acme" }, spec: {} };

describe("CertManagerClient — Certificate CR apply (fail-closed on absent cert-manager)", function _suite()
{
  it("creates the Certificate as a namespaced custom object and reads the Ready condition", async function _create()
  {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({ status: { conditions: [{ type: "Ready", status: "True" }] } });
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new CertManagerClient(customApi).applyCertificate("opencrane-acme", _MANIFEST);

    expect(createNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ group: "cert-manager.io", version: "v1", namespace: "opencrane-acme", plural: "certificates" }));
    expect(result).toEqual({ ready: true, certManagerInstalled: true });
  });

  it("gates ready:false + certManagerInstalled:false when the Certificate CRD is absent (404 on create) — never throws", async function _crdAbsent()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_NOT_FOUND);
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new CertManagerClient(customApi).applyCertificate("opencrane-acme", _MANIFEST);

    expect(result.ready).toBe(false);
    expect(result.certManagerInstalled).toBe(false);
    expect(result.reason).toContain("cert-manager is not installed");
  });

  it("replaces the Certificate on 409 carrying the live resourceVersion (idempotent re-apply)", async function _conflict()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_CONFLICT);
    const getNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { resourceVersion: "99" } });
    const replaceNamespacedCustomObject = vi.fn().mockResolvedValue({ status: { conditions: [{ type: "Ready", status: "False", message: "pending" }] } });
    const customApi = { createNamespacedCustomObject, getNamespacedCustomObject, replaceNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new CertManagerClient(customApi).applyCertificate("opencrane-acme", _MANIFEST);

    const body = replaceNamespacedCustomObject.mock.calls[0][0].body as { metadata: { resourceVersion?: string } };
    expect(body.metadata.resourceVersion).toBe("99");
    expect(result).toEqual({ ready: false, certManagerInstalled: true, reason: "pending" });
  });

  it("reports ready:false with a default reason when the Ready condition is absent (issuance in flight)", async function _noCondition()
  {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({ status: { conditions: [] } });
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new CertManagerClient(customApi).applyCertificate("opencrane-acme", _MANIFEST);

    expect(result.ready).toBe(false);
    expect(result.certManagerInstalled).toBe(true);
    expect(result.reason).toContain("in flight");
  });

  it("deletes the Certificate; a 404 (already gone) and an absent CRD are both no-ops", async function _delete()
  {
    const deleteNamespacedCustomObject = vi.fn().mockRejectedValue(_NOT_FOUND);
    const customApi = { deleteNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    await expect(new CertManagerClient(customApi).deleteCertificate("opencrane-acme", "org-wildcard-tls-acme")).resolves.toBeUndefined();
    expect(deleteNamespacedCustomObject).toHaveBeenCalledOnce();
  });
});
