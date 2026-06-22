import { describe, expect, it } from "vitest";

import { DefaultOrgDomainProvisioner } from "../../core/cluster-tenants/org-domain.provisioner.js";
import type { OrgDomainProvisionerConfig } from "../../core/cluster-tenants/org-domain.provisioner.js";
import type { CertManagerOperations, CertificateReadiness } from "../../core/cluster-tenants/cert-manager.client.js";
import type { CloudDnsOperations } from "../../core/cluster-tenants/cloud-dns.client.js";

/** Records a cert-manager apply for assertion; returns a scripted readiness. */
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

/** Records DNS ensures/deletes for assertion. */
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

const _CONFIG: OrgDomainProvisionerConfig = { issuerName: "opencrane-issuer", issuerKind: "ClusterIssuer", namespacePrefix: "opencrane-" };

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

  it("gates ready:false when the cluster has NO cert-manager — DNS still lands, no crash", async function _gatedNoCertManager()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // Fail-closed: not ready, but the call returns cleanly (never throws).
    expect(result.ready).toBe(false);
    // The Certificate apply WAS attempted (real path, not a no-op stub).
    expect(certs.applied).toHaveLength(1);
    // Serving DNS still landed so the org resolves; only browser-trusted TLS waits.
    expect(dns.ensured.map(e => e.name)).toEqual(["*.acme.weownai.eu", "acme.weownai.eu"]);
  });

  it("reports ready:false while DNS-01 issuance is still in flight (cert-manager present)", async function _inFlight()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: true, reason: "issuance in flight" });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(result.ready).toBe(false);
    expect(result.tlsSecretName).toBe("org-wildcard-tls-acme");
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
});
