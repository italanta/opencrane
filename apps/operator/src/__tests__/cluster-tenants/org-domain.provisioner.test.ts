import { describe, expect, it } from "vitest";

import { DefaultOrgDomainProvisioner } from "../../cluster-tenants/internal/org-domain.provisioner.js";
import type { OrgDomainProvisionerConfig, CertManagerOperations, CertificateReadiness, DnsEndpointOperations } from "../../cluster-tenants/internal/org-domain-provisioner.types.js";

/**
 * Records a cert-manager apply for assertion; returns a scripted readiness.
 *
 * @param readiness - The readiness the fake reports from every applyCertificate call.
 * @returns A CertManagerOperations fake that captures applied + deleted Certificates.
 */
function _fakeCerts(readiness: CertificateReadiness): CertManagerOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }>; deleted: Array<{ namespace: string; name: string }> }
{
  return {
    applied: [],
    deleted: [],
    async applyCertificate(namespace, manifest)
    {
      this.applied.push({ namespace, manifest });
      return readiness;
    },
    async deleteCertificate(namespace, name)
    {
      this.deleted.push({ namespace, name });
    },
  };
}

/**
 * Records DNSEndpoint applies/deletes for assertion; reports a scripted applied flag.
 *
 * @param applied - Whether applyDnsEndpoint reports the CR was applied (false ⇒ external-dns absent).
 * @returns A DnsEndpointOperations fake that captures applied + deleted DNSEndpoints.
 */
function _fakeDnsEndpoints(applied = true): DnsEndpointOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }>; deleted: Array<{ namespace: string; name: string }> }
{
  return {
    applied: [],
    deleted: [],
    async applyDnsEndpoint(namespace, manifest)
    {
      this.applied.push({ namespace, manifest });
      return { applied };
    },
    async deleteDnsEndpoint(namespace, name)
    {
      this.deleted.push({ namespace, name });
    },
  };
}

/** Shared issuer config for the provisioner under test. */
const _CONFIG: OrgDomainProvisionerConfig = { issuerName: "opencrane-issuer", issuerKind: "ClusterIssuer" };

/** A baseline provision request carrying an ingress IP (the DNS-served path). */
const _REQ = { orgName: "acme", boundNamespace: "opencrane-acme", platformBaseDomain: "weownai.eu", ingressIp: "203.0.113.10" };

describe("DefaultOrgDomainProvisioner — per-org wildcard cert + DNSEndpoint", function _suite()
{
  it("applies a Certificate CR with the *.<org>.<base> SAN, apex SAN, issuer ref, and per-org secret", async function _certShape()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(), _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(certs.applied).toHaveLength(1);
    const { namespace, manifest } = certs.applied[0];
    expect(namespace).toBe("opencrane-acme");
    expect(manifest.apiVersion).toBe("cert-manager.io/v1");
    expect(manifest.kind).toBe("Certificate");
    expect((manifest.metadata as Record<string, unknown>).name).toBe("org-wildcard-tls-acme");
    expect((manifest.metadata as Record<string, unknown>).namespace).toBe("opencrane-acme");
    const spec = manifest.spec as { secretName: string; issuerRef: { name: string; kind: string }; dnsNames: string[] };
    expect(spec.secretName).toBe("org-wildcard-tls-acme");
    expect(spec.issuerRef).toEqual({ name: "opencrane-issuer", kind: "ClusterIssuer" });
    expect(spec.dnsNames).toEqual(["*.acme.weownai.eu", "acme.weownai.eu"]);

    expect(result).toEqual({
      orgDomain: "acme.weownai.eu",
      wildcardDnsName: "*.acme.weownai.eu",
      tlsSecretName: "org-wildcard-tls-acme",
      ready: true,
      skipped: false,
      message: undefined,
    });
  });

  it("declares a DNSEndpoint CR with the wildcard + apex A records pointing at the ingress IP", async function _dnsShape()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDnsEndpoints();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.provisionOrgDomain(_REQ);

    expect(dns.applied).toHaveLength(1);
    const { namespace, manifest } = dns.applied[0];
    expect(namespace).toBe("opencrane-acme");
    expect(manifest.apiVersion).toBe("externaldns.k8s.io/v1alpha1");
    expect(manifest.kind).toBe("DNSEndpoint");
    expect((manifest.metadata as Record<string, unknown>).name).toBe("org-dns-acme");
    expect((manifest.metadata as Record<string, unknown>).namespace).toBe("opencrane-acme");
    const spec = manifest.spec as { endpoints: Array<{ dnsName: string; recordType: string; recordTTL: number; targets: string[] }> };
    expect(spec.endpoints).toEqual([
      { dnsName: "*.acme.weownai.eu", recordType: "A", recordTTL: 300, targets: ["203.0.113.10"] },
      { dnsName: "acme.weownai.eu", recordType: "A", recordTTL: 300, targets: ["203.0.113.10"] },
    ]);
  });

  it("appends the vanity domain (and its wildcard) to the cert SANs when set", async function _vanity()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(), _CONFIG);

    await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "acme.com" });

    const spec = certs.applied[0].manifest.spec as { dnsNames: string[] };
    expect(spec.dnsNames).toEqual(["*.acme.weownai.eu", "acme.weownai.eu", "*.acme.com", "acme.com"]);
  });

  it("is idempotent — a re-apply issues the SAME cert + DNSEndpoint manifests", async function _idempotent()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDnsEndpoints();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const first = await provisioner.provisionOrgDomain(_REQ);
    const second = await provisioner.provisionOrgDomain(_REQ);

    expect(second).toEqual(first);
    // Same manifests both times — idempotency is the client's job (create-or-replace), and
    // the provisioner emits a stable, repeatable manifest.
    expect(certs.applied[0].manifest).toEqual(certs.applied[1].manifest);
    expect(dns.applied[0].manifest).toEqual(dns.applied[1].manifest);
  });

  it("skips (skipped:true) when cert-manager is absent AND external-dns is absent", async function _gatedNoBackend()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    // external-dns absent → applyDnsEndpoint reports applied:false (fail-closed, no throw).
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(false), _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // No backend acted at all → skipped, but the call returns cleanly (never throws).
    expect(result.skipped).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/cert-manager is not installed/);
    // The Certificate apply WAS attempted (real path, not a no-op stub).
    expect(certs.applied).toHaveLength(1);
  });

  it("does NOT skip when the DNSEndpoint lands even though cert-manager is absent", async function _dnsOnly()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    const dns = _fakeDnsEndpoints(true);
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // DNS acted, so the org resolves; only browser-trusted TLS waits — not a full skip.
    expect(result.skipped).toBe(false);
    expect(result.ready).toBe(false);
    expect(dns.applied).toHaveLength(1);
  });

  it("is NOT skipped when cert-manager is present even if external-dns is absent", async function _certOnly()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    // external-dns absent (applied:false) but cert-manager present → ready, not skipped.
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(false), _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(result.ready).toBe(true);
    expect(result.skipped).toBe(false);
    expect(certs.applied).toHaveLength(1);
  });

  it("skips the DNS side when no ingress IP is supplied (no DNSEndpoint declared)", async function _noIngressIp()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDnsEndpoints();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.provisionOrgDomain({ orgName: "acme", boundNamespace: "opencrane-acme", platformBaseDomain: "weownai.eu" });

    // No ingress IP target → no DNSEndpoint applied; the cert is still applied.
    expect(dns.applied).toHaveLength(0);
    expect(certs.applied).toHaveLength(1);
  });

  it("reports ready:false (not skipped) while DNS-01 issuance is still in flight", async function _inFlight()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: true, reason: "issuance in flight" });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(), _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.tlsSecretName).toBe("org-wildcard-tls-acme");
    expect(result.message).toMatch(/issuance in flight/);
  });

  it("propagates (does NOT skip) a precondition fault from the cert client — e.g. a missing namespace", async function _precondition()
  {
    const certs: CertManagerOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }> } = {
      applied: [],
      async applyCertificate()
      {
        // The cert client re-throws a namespace-missing 404 (not masked as CRD-absent);
        // the provisioner must surface it as an error, not a silent skip.
        throw Object.assign(new Error("namespaces \"opencrane-acme\" not found"), { code: 404 });
      },
      async deleteCertificate() {},
    };
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDnsEndpoints(), _CONFIG);

    await expect(provisioner.provisionOrgDomain(_REQ)).rejects.toThrow(/not found/);
  });

  it("deprovisions by deleting the Certificate and the DNSEndpoint (idempotent teardown)", async function _deprovision()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDnsEndpoints();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.deprovisionOrgDomain("acme", "weownai.eu", "opencrane-acme");

    expect(certs.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-wildcard-tls-acme" }]);
    expect(dns.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-dns-acme" }]);
  });
});
