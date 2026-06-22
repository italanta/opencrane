import { describe, expect, it } from "vitest";

import { DefaultOrgDomainProvisioner } from "../../cluster-tenants/internal/org-domain.provisioner.js";
import type { OrgDomainProvisionerConfig, CertManagerOperations, CertificateReadiness, DnsEndpointOperations } from "../../cluster-tenants/internal/org-domain-provisioner.types.js";

/** cert-manager fake recording applies/deletes, returning a scripted readiness. */
function _fakeCerts(readiness: CertificateReadiness): CertManagerOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }>; deleted: Array<{ namespace: string; name: string }> }
{
  return {
    applied: [],
    deleted: [],
    async applyCertificate(namespace: string, manifest: Record<string, unknown>) { this.applied.push({ namespace, manifest }); return readiness; },
    async deleteCertificate(namespace: string, name: string) { this.deleted.push({ namespace, name }); },
  };
}

/** external-dns DNSEndpoint fake recording applies/deletes. */
function _fakeDns(applied = true): DnsEndpointOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }>; deleted: Array<{ namespace: string; name: string }> }
{
  return {
    applied: [],
    deleted: [],
    async applyDnsEndpoint(namespace: string, manifest: Record<string, unknown>) { this.applied.push({ namespace, manifest }); return { applied }; },
    async deleteDnsEndpoint(namespace: string, name: string) { this.deleted.push({ namespace, name }); },
  };
}

const _CONFIG: OrgDomainProvisionerConfig = { issuerName: "opencrane-issuer", issuerKind: "ClusterIssuer" };
/** Baseline request carrying an ingress IP (the DNS-served path). No vanity. */
const _REQ = { orgName: "acme", boundNamespace: "opencrane-acme", platformBaseDomain: "weownai.eu", ingressIp: "203.0.113.10" };

describe("DefaultOrgDomainProvisioner — single-per-org-host (explicit <org>.<base> record)", () =>
{
  it("declares an EXPLICIT <org>.<base> A record (no per-user wildcard) and no cert when there's no vanity", async () =>
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(dns.applied).toHaveLength(1);
    const { namespace, manifest } = dns.applied[0];
    expect(namespace).toBe("opencrane-acme");
    expect((manifest.metadata as Record<string, unknown>).name).toBe("org-dns-acme");
    const spec = manifest.spec as { endpoints: Array<{ dnsName: string; recordType: string; targets: string[] }> };
    // ONE explicit record for the org host — no `*.acme.weownai.eu` wildcard.
    expect(spec.endpoints).toEqual([{ dnsName: "acme.weownai.eu", recordType: "A", recordTTL: 300, targets: ["203.0.113.10"] }]);
    // No vanity → no per-org certificate (canonical host rides the platform `*.<base>` cert).
    expect(certs.applied).toHaveLength(0);
    expect(result).toEqual({ orgDomain: "acme.weownai.eu", tlsSecretName: undefined, ready: true, skipped: false, message: undefined });
  });

  it("issues a vanity-only cert (SAN = vanity, no wildcard) when a vanity domain is set", async () =>
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _fakeDns(), _CONFIG);

    const result = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });

    expect(certs.applied).toHaveLength(1);
    const spec = certs.applied[0].manifest.spec as { secretName: string; dnsNames: string[] };
    expect(spec.secretName).toBe("org-vanity-tls-acme");
    expect(spec.dnsNames).toEqual(["ai.client-co.com"]);
    expect(result.ready).toBe(true);
    expect(result.tlsSecretName).toBe("org-vanity-tls-acme");
  });

  it("skips the DNS side when no ingress IP is supplied", async () =>
  {
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(_fakeCerts({ ready: true, certManagerInstalled: true }), dns, _CONFIG);

    const result = await provisioner.provisionOrgDomain({ orgName: "acme", boundNamespace: "opencrane-acme", platformBaseDomain: "weownai.eu" });

    expect(dns.applied).toHaveLength(0);
    // No DNS target and no vanity cert → nothing acted → skipped (never throws).
    expect(result.skipped).toBe(true);
  });

  it("skips (no throw) when external-dns is absent and there's no vanity cert", async () =>
  {
    const provisioner = new DefaultOrgDomainProvisioner(_fakeCerts({ ready: false, certManagerInstalled: false }), _fakeDns(false), _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    expect(result.skipped).toBe(true);
    expect(result.ready).toBe(false);
  });

  it("deprovisions by deleting the vanity Certificate and the org-host DNSEndpoint", async () =>
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const dns = _fakeDns();
    const provisioner = new DefaultOrgDomainProvisioner(certs, dns, _CONFIG);

    await provisioner.deprovisionOrgDomain("acme", "weownai.eu", "opencrane-acme");

    expect(certs.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-vanity-tls-acme" }]);
    expect(dns.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-dns-acme" }]);
  });
});
