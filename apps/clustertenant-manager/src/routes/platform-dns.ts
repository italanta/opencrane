import { Router } from "express";
import * as k8s from "@kubernetes/client-node";

import { _ApplyPlatformDnsConfig } from "../core/platform-dns/apply-dns-config.js";
import { _DnsProviderConfigError } from "../core/platform-dns/cluster-issuer.js";
import type { CertIssuerKind } from "../core/platform-dns/cluster-issuer.types.js";
import { _IsK8sNotFound } from "@opencrane/infra-api";
import type { PlatformDnsStatus } from "./platform-dns.types.js";

/** Default issuer name when the request omits one. */
const _DEFAULT_ISSUER_NAME = "opencrane-issuer";

/** cert-manager API coordinates for reading an issuer back. */
const _CM_GROUP = "cert-manager.io";
const _CM_VERSION = "v1";
/** Plural for the cluster-scoped `ClusterIssuer` custom resource. */
const _CM_CLUSTER_ISSUER_PLURAL = "clusterissuers";
/** Plural for the namespaced `Issuer` custom resource (MI.4). */
const _CM_ISSUER_PLURAL = "issuers";

/**
 * Resolve the cert-issuer kind the platform-DNS path targets from the
 * environment (MI.4). Defaults to the legacy cluster-wide `ClusterIssuer`; set
 * `PLATFORM_DNS_ISSUER_KIND=Issuer` (wired by the Helm chart in namespaced
 * multi-instance mode) for a per-instance namespaced Issuer.
 *
 * @returns The configured issuer kind.
 */
function _ResolveIssuerKind(): CertIssuerKind
{
  return process.env.PLATFORM_DNS_ISSUER_KIND === "Issuer" ? "Issuer" : "ClusterIssuer";
}

/**
 * Resolve the namespace a namespaced `Issuer` (and its solver Secret) is written
 * to (MI.4). Prefers `PLATFORM_DNS_ISSUER_NAMESPACE`, then the pod's own
 * `NAMESPACE` (the instance namespace), then the cert-manager namespace.
 *
 * @param certManagerNamespace - Fallback cert-manager controller namespace.
 * @returns The target instance namespace.
 */
function _ResolveIssuerNamespace(certManagerNamespace: string): string
{
  return process.env.PLATFORM_DNS_ISSUER_NAMESPACE ?? process.env.NAMESPACE ?? certManagerNamespace;
}

/**
 * Onboarding router for platform TLS/DNS issuance (CONN.8a, MI.4).
 *
 * `PUT /` captures a DNS-provider config and applies the cert-manager DNS-01
 * issuer (+ credentials Secret) that issues the wildcard tenant cert; `GET /`
 * reports the currently configured issuer. The issuer kind is environment-driven
 * (`PLATFORM_DNS_ISSUER_KIND`): a cluster-wide `ClusterIssuer` by default, or a
 * per-instance namespaced `Issuer` in multi-instance mode (brief B4). Mounted
 * under `/api/v1/platform/dns` behind `___AuthMiddleware` — a platform-admin surface.
 *
 * @param customApi - Kubernetes custom-objects client (issuer CRDs).
 * @param coreApi   - Kubernetes core client (credentials Secret).
 * @returns Configured Express router.
 */
export function platformDnsRouter(customApi: k8s.CustomObjectsApi, coreApi: k8s.CoreV1Api): Router
{
  const router = Router();
  const certManagerNamespace = process.env.CERT_MANAGER_NAMESPACE ?? "cert-manager";
  const issuerKind = _ResolveIssuerKind();
  const issuerNamespace = issuerKind === "Issuer" ? _ResolveIssuerNamespace(certManagerNamespace) : null;

  /** Configure (create/update) the platform DNS-01 issuer. */
  router.put("/", async function _setDns(req, res, next)
  {
    try
    {
      const provider = typeof req.body?.provider === "string" ? req.body.provider.trim() : "";
      const zone = typeof req.body?.zone === "string" ? req.body.zone.trim() : "";
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";

      // 1. Require the three fields the ACME DNS-01 issuer cannot be built without.
      if (provider.length === 0 || zone.length === 0 || email.length === 0)
      {
        res.status(400).json({ error: "provider, zone and email are required", code: "VALIDATION_ERROR" });
        return;
      }

      // 2. Apply the issuer + Secret. The kind/namespace come from the environment
      //    (cluster-wide by default; per-instance Issuer in multi-instance mode), so
      //    two instances never collide on one cluster-singleton issuer (brief B4).
      const result = await _ApplyPlatformDnsConfig(customApi, coreApi, {
        provider,
        zone,
        email,
        server: typeof req.body?.server === "string" ? req.body.server.trim() : undefined,
        issuerName: typeof req.body?.issuerName === "string" && req.body.issuerName.trim().length > 0 ? req.body.issuerName.trim() : _DEFAULT_ISSUER_NAME,
        issuerKind,
        issuerNamespace: issuerNamespace ?? undefined,
        apiToken: typeof req.body?.apiToken === "string" ? req.body.apiToken : undefined,
        solverConfig: typeof req.body?.solverConfig === "object" && req.body.solverConfig !== null ? req.body.solverConfig : undefined,
      }, certManagerNamespace);

      res.json({ status: "configured", ...result });
    }
    catch (err)
    {
      // A render-time provider misconfiguration is a client error, not a 500.
      if (err instanceof _DnsProviderConfigError)
      {
        res.status(422).json({ error: err.message, code: "DNS_PROVIDER_MISCONFIGURED" });
        return;
      }
      next(err);
    }
  });

  /** Report the currently configured platform DNS issuer. */
  router.get("/", async function _showDns(req, res, next)
  {
    try
    {
      const issuerName = typeof req.query.issuerName === "string" && req.query.issuerName.length > 0 ? req.query.issuerName : _DEFAULT_ISSUER_NAME;

      let issuer: unknown;
      try
      {
        // Read back the same kind the PUT path writes — a namespaced Issuer in the
        // instance namespace, or the cluster-wide ClusterIssuer otherwise.
        issuer = issuerKind === "Issuer"
          ? await customApi.getNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace: issuerNamespace as string, plural: _CM_ISSUER_PLURAL, name: issuerName })
          : await customApi.getClusterCustomObject({ group: _CM_GROUP, version: _CM_VERSION, plural: _CM_CLUSTER_ISSUER_PLURAL, name: issuerName });
      }
      catch (lookupErr)
      {
        // Only a 404 (issuer absent / cert-manager CRD not installed) means
        // "unconfigured" — propagate auth/permission/server errors instead of
        // masking them as a clean not-configured response.
        if (_IsK8sNotFound(lookupErr))
        {
          res.json({ configured: false, issuerName, issuerKind, issuerNamespace, provider: null, email: null, server: null } satisfies PlatformDnsStatus);
          return;
        }
        throw lookupErr;
      }

      res.json(_SummariseIssuer(issuer, issuerName, issuerKind, issuerNamespace));
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}


/**
 * Extract a non-secret status summary from an issuer custom resource.
 * @param issuer          - The raw issuer object.
 * @param issuerName      - The issuer name queried.
 * @param issuerKind      - The kind queried (ClusterIssuer | Issuer).
 * @param issuerNamespace - The namespace queried for an Issuer, or null for a ClusterIssuer.
 */
function _SummariseIssuer(issuer: unknown, issuerName: string, issuerKind: CertIssuerKind, issuerNamespace: string | null): PlatformDnsStatus
{
  const acme = (issuer as { spec?: { acme?: { email?: string; server?: string; solvers?: Array<{ dns01?: Record<string, unknown> }> } } }).spec?.acme;
  const dns01 = acme?.solvers?.[0]?.dns01 ?? {};
  // The provider is the single key of the dns01 solver block (e.g. `cloudflare`).
  const provider = Object.keys(dns01).find(function _notType(key) { return key !== "cnameStrategy"; }) ?? null;
  return {
    configured: true,
    issuerName,
    issuerKind,
    issuerNamespace,
    provider,
    email: acme?.email ?? null,
    server: acme?.server ?? null,
  };
}
