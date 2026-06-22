import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import { DnsEndpointClient } from "../../cluster-tenants/internal/dns-endpoint.client.js";

/** A 404 the API server returns when the external-dns DNSEndpoint CRD type is NOT served. */
const _CRD_ABSENT = Object.assign(new Error("the server could not find the requested resource"), { code: 404, body: { message: "the server could not find the requested resource" } });
/** A 404 whose Status names the externaldns.k8s.io group as the missing subject. */
const _CRD_ABSENT_BY_GROUP = Object.assign(new Error("not found"), { code: 404, body: { reason: "NotFound", details: { group: "externaldns.k8s.io", kind: "dnsendpoints", name: "org-dns-acme" } } });
/** A 404 the API server returns when the TARGET NAMESPACE is missing (CRD present). */
const _NAMESPACE_MISSING = Object.assign(new Error("namespaces \"opencrane-acme\" not found"), { code: 404, body: { reason: "NotFound", message: "namespaces \"opencrane-acme\" not found", details: { kind: "namespaces", name: "opencrane-acme" } } });
/** A plain 404 (already-gone) for delete idempotency. */
const _NOT_FOUND = Object.assign(new Error("not found"), { code: 404 });
/** A 409 error matching the client's conflict shape. */
const _CONFLICT = Object.assign(new Error("already exists"), { code: 409 });

const _MANIFEST = { apiVersion: "externaldns.k8s.io/v1alpha1", kind: "DNSEndpoint", metadata: { name: "org-dns-acme", namespace: "opencrane-acme" }, spec: { endpoints: [] } };

describe("DnsEndpointClient — DNSEndpoint CR apply (fail-closed on absent external-dns)", function _suite()
{
  it("creates the DNSEndpoint as a namespaced custom object", async function _create()
  {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new DnsEndpointClient(customApi).applyDnsEndpoint("opencrane-acme", _MANIFEST);

    expect(createNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ group: "externaldns.k8s.io", version: "v1alpha1", namespace: "opencrane-acme", plural: "dnsendpoints" }));
    expect(result).toEqual({ applied: true });
  });

  it("gates applied:false when the DNSEndpoint CRD is absent (unserved-type 404) — never throws", async function _crdAbsent()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_CRD_ABSENT);
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new DnsEndpointClient(customApi).applyDnsEndpoint("opencrane-acme", _MANIFEST);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("external-dns is not installed");
  });

  it("gates CRD-absent when the 404 Status names the externaldns.k8s.io group, even with a details.name", async function _crdAbsentByGroup()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_CRD_ABSENT_BY_GROUP);
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new DnsEndpointClient(customApi).applyDnsEndpoint("opencrane-acme", _MANIFEST);

    // A group-pinned 404 is unambiguously the DNSEndpoint TYPE being unserved — a missing
    // namespace never carries `details.group`. Fail closed, do not re-throw.
    expect(result.applied).toBe(false);
  });

  it("RE-THROWS a namespace-missing 404 rather than misattributing it as external-dns-absent", async function _namespaceMissing()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_NAMESPACE_MISSING);
    const customApi = { createNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    // A missing target namespace is a real precondition fault — it must NOT be masked as
    // "external-dns is not installed" (which would mislead operators).
    await expect(new DnsEndpointClient(customApi).applyDnsEndpoint("opencrane-acme", _MANIFEST)).rejects.toThrow(/not found/);
  });

  it("replaces the DNSEndpoint on 409 carrying the live resourceVersion (idempotent re-apply)", async function _conflict()
  {
    const createNamespacedCustomObject = vi.fn().mockRejectedValue(_CONFLICT);
    const getNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { resourceVersion: "42" } });
    const replaceNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const customApi = { createNamespacedCustomObject, getNamespacedCustomObject, replaceNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    const result = await new DnsEndpointClient(customApi).applyDnsEndpoint("opencrane-acme", _MANIFEST);

    const body = replaceNamespacedCustomObject.mock.calls[0][0].body as { metadata: { resourceVersion?: string } };
    expect(body.metadata.resourceVersion).toBe("42");
    expect(result).toEqual({ applied: true });
  });

  it("deletes the DNSEndpoint; a 404 (already gone) and an absent CRD are both no-ops", async function _delete()
  {
    const deleteNamespacedCustomObject = vi.fn().mockRejectedValue(_NOT_FOUND);
    const customApi = { deleteNamespacedCustomObject } as unknown as k8s.CustomObjectsApi;

    await expect(new DnsEndpointClient(customApi).deleteDnsEndpoint("opencrane-acme", "org-dns-acme")).resolves.toBeUndefined();
    expect(deleteNamespacedCustomObject).toHaveBeenCalledOnce();
  });
});
