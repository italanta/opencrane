import { describe, expect, it } from "vitest";

import { DefaultOrgDomainProvisioner } from "../../cluster-tenants/internal/org-domain.provisioner.js";
import type { OrgDomainProvisionerConfig, CertManagerOperations, CertificateReadiness, CloudDnsOperations } from "../../cluster-tenants/internal/org-domain-provisioner.types.js";

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
 * Records DNS ensures/deletes for assertion.
 *
 * @returns A CloudDnsOperations fake that captures ensured + deleted records.
 */
function _fakeDns(): CloudDnsOperations & { ensured: Array<{ name: string; rrdatas: string[]; ttl: number }>; deleted: string[] }
{
  return {
    ensured: [],
    deleted: [],
    async ensureARecord(name, rrdatas, ttl)
    {
      this.ensured.push({ name, rrdatas, ttl });
    },
    async deleteARecord(name)
    {
      this.deleted.push(name);
    },
  };
}

/** Shared issuer + namespace config for the provisioner under test. */
const _CONFIG: OrgDomainProvisionerConfig = { issuerName: "opencrane-issuer", issuerKind: "ClusterIssuer", namespacePrefix: "opencrane-" };

/** A baseline provision request carrying an ingress IP (the DNS-served path). */
const _REQ = { orgName: "acme", platformBaseDomain: "weownai.eu", ingressIp: "203.0.113.10" };

describe("DefaultOrgDomainProvisioner — per-org wildcard cert + Cloud DNS", function _suite()
{
  it("applies a Certificate CR with the *.<org>.<base> SAN, apex SAN, issuer ref, and per-org secret", async function _certShape()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

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

  it("ensures the per-org wildcard AND apex A records point at the ingress IP", async function _dnsShape()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.provisionOrgDomain(_REQ);

    expect(dns.ensured).toEqual([
      { name: "*.acme.weownai.eu", rrdatas: ["203.0.113.10"], ttl: 300 },
      { name: "acme.weownai.eu", rrdatas: ["203.0.113.10"], ttl: 300 },
    ]);
  });

  it("appends the vanity domain (and its wildcard) to the cert SANs when set", async function _vanity()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "acme.com" });

    const spec = certs.applied[0].manifest.spec as { dnsNames: string[] };
    expect(spec.dnsNames).toEqual(["*.acme.weownai.eu", "acme.weownai.eu", "*.acme.com", "acme.com"]);
  });

  it("is idempotent — a re-apply issues the SAME cert + DNS requests (clients absorb the no-op)", async function _idempotent()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const first = await provisioner.provisionOrgDomain(_REQ);
    const second = await provisioner.provisionOrgDomain(_REQ);

    expect(second).toEqual(first);
    // Same request shape both times — idempotency is the client's job (create-or-replace
    // / same-data no-op), and the provisioner emits a stable, repeatable request.
    expect(certs.applied[0].manifest).toEqual(certs.applied[1].manifest);
    expect(dns.ensured.slice(0, 2)).toEqual(dns.ensured.slice(2, 4));
  });

  it("skips (skipped:true) when cert-manager is absent AND no DNS zone is configured", async function _gatedNoBackend()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    const provisioner = new DefaultOrgDomainProvisioner(certs, null, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // No backend acted at all → skipped, but the call returns cleanly (never throws).
    expect(result.skipped).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/cert-manager is not installed/);
    // The Certificate apply WAS attempted (real path, not a no-op stub).
    expect(certs.applied).toHaveLength(1);
  });

  it("does NOT skip when DNS lands even though cert-manager is absent (DNS still serves)", async function _dnsOnly()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // DNS acted, so the org resolves; only browser-trusted TLS waits — not a full skip.
    expect(result.skipped).toBe(false);
    expect(result.ready).toBe(false);
    expect(dns.ensured.map(e => e.name)).toEqual(["*.acme.weownai.eu", "acme.weownai.eu"]);
  });

  it("skips the DNS side when no Cloud DNS zone is configured (null client), cert still applied", async function _noDnsZone()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, null, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // cert-manager present → ready and NOT skipped, but DNS never ran (null client).
    expect(result.ready).toBe(true);
    expect(result.skipped).toBe(false);
    expect(certs.applied).toHaveLength(1);
  });

  it("skips the DNS side when no ingress IP is supplied, even with a zone configured", async function _noIngressIp()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.provisionOrgDomain({ orgName: "acme", platformBaseDomain: "weownai.eu" });

    // No ingress IP target → DNS side effect is skipped; the cert is still applied.
    expect(dns.ensured).toHaveLength(0);
    expect(certs.applied).toHaveLength(1);
  });

  it("reports ready:false (not skipped) while DNS-01 issuance is still in flight", async function _inFlight()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: true, reason: "issuance in flight" });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.tlsSecretName).toBe("org-wildcard-tls-acme");
    expect(result.message).toMatch(/issuance in flight/);
  });

  it("deprovisions by deleting the Certificate and both A records (idempotent teardown)", async function _deprovision()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.deprovisionOrgDomain("acme", "weownai.eu");

    expect(certs.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-wildcard-tls-acme" }]);
    expect(dns.deleted).toEqual(["*.acme.weownai.eu", "acme.weownai.eu"]);
  });

  it("deprovisions the Certificate only when no DNS zone is configured (null client)", async function _deprovisionNoDns()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, null, _CONFIG);

    await provisioner.deprovisionOrgDomain("acme", "weownai.eu");

    expect(certs.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-wildcard-tls-acme" }]);
  });
});
