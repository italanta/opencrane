import { describe, expect, it } from "vitest";

import { DefaultOrgDomainProvisioner } from "../../cluster-tenants/internal/org-domain.provisioner.js";
import type { OrgDomainProvisionerConfig, CertManagerOperations, CertificateReadiness } from "../../cluster-tenants/internal/org-domain-provisioner.types.js";

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
    async applyCertificate(namespace: string, manifest: Record<string, unknown>)
    {
      this.applied.push({ namespace, manifest });
      return readiness;
    },
    async deleteCertificate(namespace: string, name: string)
    {
      this.deleted.push({ namespace, name });
    },
  };
}

/** Shared issuer config for the provisioner under test. */
const _CONFIG: OrgDomainProvisionerConfig = { issuerName: "opencrane-issuer", issuerKind: "ClusterIssuer" };

/** A baseline request with no vanity domain (the canonical-host-only path). */
const _REQ = { orgName: "acme", boundNamespace: "opencrane-acme", platformBaseDomain: "weownai.eu" };

describe("DefaultOrgDomainProvisioner — single-per-org-host (vanity-only cert)", function _suite()
{
  it("does NO per-org work for the canonical host — covered by the platform *.<base> cert", async function _noVanity()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    const result = await provisioner.provisionOrgDomain(_REQ);

    // No vanity → no Certificate applied; the org host `<org>.<base>` rides the platform wildcard.
    expect(certs.applied).toHaveLength(0);
    expect(result).toEqual({ orgDomain: "acme.weownai.eu", ready: true, skipped: false });
  });

  it("issues a per-org Certificate with ONLY the vanity SAN (no wildcard) when a vanity domain is set", async function _vanityShape()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    const result = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });

    expect(certs.applied).toHaveLength(1);
    const { namespace, manifest } = certs.applied[0];
    expect(namespace).toBe("opencrane-acme");
    expect(manifest.apiVersion).toBe("cert-manager.io/v1");
    expect(manifest.kind).toBe("Certificate");
    expect((manifest.metadata as Record<string, unknown>).name).toBe("org-vanity-tls-acme");
    const spec = manifest.spec as { secretName: string; issuerRef: { name: string; kind: string }; dnsNames: string[] };
    expect(spec.secretName).toBe("org-vanity-tls-acme");
    expect(spec.issuerRef).toEqual({ name: "opencrane-issuer", kind: "ClusterIssuer" });
    // ONLY the vanity host — no `*.<org>.<base>` wildcard (per-user subdomains are gone).
    expect(spec.dnsNames).toEqual(["ai.client-co.com"]);

    expect(result).toEqual({
      orgDomain: "acme.weownai.eu",
      tlsSecretName: "org-vanity-tls-acme",
      ready: true,
      skipped: false,
      message: undefined,
    });
  });

  it("is idempotent — a re-apply issues the SAME vanity cert manifest", async function _idempotent()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    const first = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });
    const second = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });

    expect(second).toEqual(first);
    expect(certs.applied[0].manifest).toEqual(certs.applied[1].manifest);
  });

  it("skips (skipped:true, never throws) when a vanity cert is requested but cert-manager is absent", async function _gatedNoBackend()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: false, reason: "cert-manager is not installed" });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    const result = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });

    expect(result.skipped).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/cert-manager/);
    // The Certificate apply WAS attempted (real path, not a no-op stub).
    expect(certs.applied).toHaveLength(1);
  });

  it("reports ready:false (not skipped) while vanity issuance is still in flight", async function _inFlight()
  {
    const certs = _fakeCerts({ ready: false, certManagerInstalled: true, reason: "issuance in flight" });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    const result = await provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.tlsSecretName).toBe("org-vanity-tls-acme");
    expect(result.message).toMatch(/issuance in flight/);
  });

  it("propagates (does NOT skip) a precondition fault from the cert client — e.g. a missing namespace", async function _precondition()
  {
    const certs: CertManagerOperations & { applied: Array<{ namespace: string; manifest: Record<string, unknown> }> } = {
      applied: [],
      async applyCertificate()
      {
        throw Object.assign(new Error("namespaces \"opencrane-acme\" not found"), { code: 404 });
      },
      async deleteCertificate() {},
    };
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    await expect(provisioner.provisionOrgDomain({ ..._REQ, vanityDomain: "ai.client-co.com" })).rejects.toThrow(/not found/);
  });

  it("deprovisions by deleting the per-org vanity Certificate (idempotent teardown)", async function _deprovision()
  {
    const certs = _fakeCerts({ ready: true, certManagerInstalled: true });
    const provisioner = new DefaultOrgDomainProvisioner(certs, _CONFIG);

    await provisioner.deprovisionOrgDomain("acme", "weownai.eu", "opencrane-acme");

    expect(certs.deleted).toEqual([{ namespace: "opencrane-acme", name: "org-vanity-tls-acme" }]);
  });
});
