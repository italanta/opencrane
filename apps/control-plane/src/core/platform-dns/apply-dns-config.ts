import * as k8s from "@kubernetes/client-node";

import { _IsK8sConflict } from "../../shared/k8s-errors.js";
import { _RenderDns01Issuer, _RenderDnsCredentialsSecret } from "./cluster-issuer.js";
import type { CertIssuerKind, DnsProviderConfig } from "./cluster-issuer.types.js";
import type { ApplyDnsConfigResult } from "./apply-dns-config.types.js";

/** cert-manager API group/version for the issuer custom resources. */
const _CM_GROUP = "cert-manager.io";
const _CM_VERSION = "v1";
/** Plural for the cluster-scoped `ClusterIssuer` custom resource. */
const _CM_CLUSTER_ISSUER_PLURAL = "clusterissuers";
/** Plural for the namespaced `Issuer` custom resource (MI.4). */
const _CM_ISSUER_PLURAL = "issuers";

/**
 * Apply a platform DNS-provider configuration (CONN.8a, MI.4).
 *
 * Idempotently upserts the cert-manager DNS credentials Secret (when a token is
 * supplied) then the ACME DNS-01 issuer that references it. cert-manager then
 * issues/renews the wildcard `*.<zone>` cert tenant Ingresses serve — no
 * per-tenant issuance.
 *
 * Issuer scope follows `config.issuerKind` (MI.4, brief B4):
 * - `ClusterIssuer` (DEFAULT): a cluster-singleton issuer; the solver Secret is
 *   written to `certManagerNamespace` (cert-manager reads ClusterIssuer solver
 *   Secrets only from its own namespace) — legacy single-install behavior.
 * - `Issuer`: a per-instance namespaced issuer in `config.issuerNamespace`; the
 *   solver Secret is written to that SAME namespace, so two instances never fight
 *   over one cluster-wide issuer + shared cert-manager-ns credential Secret.
 *
 * The live cert-manager pickup (does the issued cert appear in the wildcard
 * Secret) needs a cluster + real DNS and is the CONN.8(d) e2e seam; this
 * function's job is to author the two resources correctly and apply them.
 *
 * @param customApi            - Kubernetes custom-objects client (issuer CRDs).
 * @param coreApi              - Kubernetes core client (credentials Secret).
 * @param config               - The DNS-provider configuration.
 * @param certManagerNamespace - Namespace a cluster-wide ClusterIssuer's solver Secret is written to.
 * @returns A summary of what was applied.
 */
export async function _ApplyPlatformDnsConfig(customApi: k8s.CustomObjectsApi,
                                              coreApi: k8s.CoreV1Api,
                                              config: DnsProviderConfig,
                                              certManagerNamespace: string): Promise<ApplyDnsConfigResult>
{
  // 1. Resolve the issuer kind + the namespace the solver Secret must live in.
  //    A namespaced Issuer co-locates its Secret in the instance namespace;
  //    a cluster-wide ClusterIssuer uses the shared cert-manager namespace.
  const kind: CertIssuerKind = config.issuerKind ?? "ClusterIssuer";
  const issuerNamespace = kind === "Issuer" ? (config.issuerNamespace ?? certManagerNamespace) : null;
  const secretNamespace = issuerNamespace ?? certManagerNamespace;

  // 2. Render + upsert the credentials Secret first (when token-based), so the
  //    issuer solver has a Secret to reference the moment it is created.
  const secret = _RenderDnsCredentialsSecret(config, secretNamespace);
  if (secret)
  {
    await _UpsertSecret(coreApi, secretNamespace, secret.name, secret.manifest);
  }

  // 3. Render the issuer (throws on a misconfigured provider) and upsert it;
  //    building it here means an invalid config fails before any K8s write.
  const issuer = _RenderDns01Issuer(config, secret?.name ?? null);
  if (kind === "Issuer")
  {
    await _UpsertNamespacedIssuer(customApi, issuerNamespace as string, config.issuerName, issuer);
  }
  else
  {
    await _UpsertClusterIssuer(customApi, config.issuerName, issuer);
  }

  return {
    issuerName: config.issuerName,
    issuerKind: kind,
    issuerNamespace,
    provider: config.provider,
    zone: config.zone,
    secretName: secret?.name ?? null,
  };
}

/**
 * Create the Secret, or replace it when it already exists (idempotent).
 * @param coreApi   - Core V1 client.
 * @param namespace - Target namespace.
 * @param name      - Secret name.
 * @param manifest  - The Secret manifest to apply.
 */
async function _UpsertSecret(coreApi: k8s.CoreV1Api, namespace: string, name: string, manifest: Record<string, unknown>): Promise<void>
{
  try
  {
    await coreApi.createNamespacedSecret({ namespace, body: manifest as unknown as k8s.V1Secret });
  }
  catch (err)
  {
    // 409 Conflict → the Secret exists; replace it so a rotated token takes effect.
    if (_IsK8sConflict(err))
    {
      await coreApi.replaceNamespacedSecret({ name, namespace, body: manifest as unknown as k8s.V1Secret });
      return;
    }
    throw err;
  }
}

/**
 * Create the cluster-wide ClusterIssuer, or replace it when it already exists (idempotent).
 * @param customApi - Custom-objects client.
 * @param name      - ClusterIssuer name.
 * @param manifest  - The ClusterIssuer manifest to apply.
 */
async function _UpsertClusterIssuer(customApi: k8s.CustomObjectsApi, name: string, manifest: Record<string, unknown>): Promise<void>
{
  try
  {
    await customApi.createClusterCustomObject({ group: _CM_GROUP, version: _CM_VERSION, plural: _CM_CLUSTER_ISSUER_PLURAL, body: manifest });
  }
  catch (err)
  {
    // 409 Conflict → exists; fetch the live resourceVersion and replace.
    if (_IsK8sConflict(err))
    {
      const existing = await customApi.getClusterCustomObject({ group: _CM_GROUP, version: _CM_VERSION, plural: _CM_CLUSTER_ISSUER_PLURAL, name });
      const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
      const body = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), resourceVersion } };
      await customApi.replaceClusterCustomObject({ group: _CM_GROUP, version: _CM_VERSION, plural: _CM_CLUSTER_ISSUER_PLURAL, name, body });
      return;
    }
    throw err;
  }
}

/**
 * Create the namespaced Issuer, or replace it when it already exists (idempotent, MI.4).
 * @param customApi - Custom-objects client.
 * @param namespace - The instance namespace the Issuer lives in.
 * @param name      - Issuer name.
 * @param manifest  - The Issuer manifest to apply.
 */
async function _UpsertNamespacedIssuer(customApi: k8s.CustomObjectsApi, namespace: string, name: string, manifest: Record<string, unknown>): Promise<void>
{
  try
  {
    await customApi.createNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_ISSUER_PLURAL, body: manifest });
  }
  catch (err)
  {
    // 409 Conflict → exists; fetch the live resourceVersion and replace in-place.
    if (_IsK8sConflict(err))
    {
      const existing = await customApi.getNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_ISSUER_PLURAL, name });
      const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
      const body = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), resourceVersion } };
      await customApi.replaceNamespacedCustomObject({ group: _CM_GROUP, version: _CM_VERSION, namespace, plural: _CM_ISSUER_PLURAL, name, body });
      return;
    }
    throw err;
  }
}

