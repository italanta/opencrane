import { Router } from "express";
import { ModelRoutingScope } from "@opencrane/contracts";
import type { ProviderCredential, ProviderCredentialWrite } from "@opencrane/contracts";
import type { Prisma, PrismaClient, ProviderCredential as PrismaProviderCredential } from "@prisma/client";

import { _ClusterTenantScopeGuard } from "../infra/middleware/cluster-tenant-scope.js";
import type { ClusterTenantScopedResource } from "../infra/middleware/cluster-tenant-scope.types.js";

/** Raw-key field names that must never be accepted or stored (keys live in k8s Secrets). */
const _RAW_KEY_FIELDS = ["apiKey", "keyValue", "key"] as const;

/**
 * Project a persisted provider-credential row into its contract DTO. The Prisma enum
 * values map 1:1 to the lowercase {@link ModelRoutingScope} string union.
 *
 * @param row - The persisted `ProviderCredential` row.
 * @returns The contract-shaped credential (timestamps as ISO-8601 strings).
 */
function _toContract(row: PrismaProviderCredential): ProviderCredential
{
  return {
    id: row.id,
    scope: row.scope === "ClusterTenant" ? ModelRoutingScope.ClusterTenant : ModelRoutingScope.Global,
    clusterTenant: row.clusterTenant,
    provider: row.provider,
    secretRef: row.secretRef,
    litellmCredentialName: row.litellmCredentialName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a contract scope string to the Prisma `ModelRoutingScope` enum value. */
function _toPrismaScope(scope: ModelRoutingScope): "Global" | "ClusterTenant"
{
  return scope === ModelRoutingScope.ClusterTenant ? "ClusterTenant" : "Global";
}

/**
 * Validate a {@link ProviderCredentialWrite} body. Returns an error envelope string when
 * invalid, or null when the body is acceptable. Enforces the locked decisions: required
 * `provider` + `secretRef`, `clusterTenant` required when scope is `clusterTenant`, and a
 * hard reject of any raw-key field — the raw key must live in a k8s Secret, never here.
 *
 * @param body - The untrusted request body.
 * @returns A `{ error, code }` payload when invalid; null when valid.
 */
function _validateWrite(body: Record<string, unknown>): { error: string; code: string } | null
{
  // 1. Reject any raw-key field outright — OpenCrane stores only a `secretRef`, never the key.
  for (const field of _RAW_KEY_FIELDS)
  {
    if (body[field] !== undefined)
    {
      return { error: `Raw key field '${field}' is not accepted; pass 'secretRef' instead (the key lives in a k8s Secret).`, code: "RAW_KEY_REJECTED" };
    }
  }

  // 2. `provider` and `secretRef` are always required.
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const secretRef = typeof body.secretRef === "string" ? body.secretRef.trim() : "";
  if (!provider || !secretRef)
  {
    return { error: "provider and secretRef are required.", code: "VALIDATION_ERROR" };
  }

  // 3. When scoped to a ClusterTenant, the owning clusterTenant key is mandatory.
  const scope = body.scope ?? ModelRoutingScope.Global;
  if (scope === ModelRoutingScope.ClusterTenant && !(typeof body.clusterTenant === "string" && body.clusterTenant.trim()))
  {
    return { error: "clusterTenant is required when scope is 'clusterTenant'.", code: "VALIDATION_ERROR" };
  }
  if (scope !== ModelRoutingScope.Global && scope !== ModelRoutingScope.ClusterTenant)
  {
    return { error: "scope must be 'global' or 'clusterTenant'.", code: "VALIDATION_ERROR" };
  }

  return null;
}

/**
 * CRUD router for {@link ProviderCredential} — provider API credential *references*.
 *
 * Credentials are owned at Global (control-plane) or ClusterTenant scope, NEVER per
 * openclaw tenant. The body carries only a `secretRef` (the External-Secrets-synced k8s
 * Secret name) plus an optional `litellmCredentialName`; a request carrying a raw key is
 * rejected with 400. Mutations are gated by the ClusterTenant scope guard (AIR.0b).
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function providerCredentialsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  // Mutation guard: resolve the targeted credential's scope so the guard can decide.
  // For POST the scope comes from the body; for PUT/DELETE from the persisted row.
  const guard = _ClusterTenantScopeGuard(prisma, async function _resolveResource(req): Promise<ClusterTenantScopedResource | null>
  {
    if (req.method === "POST")
    {
      const body = (req.body ?? {}) as ProviderCredentialWrite;
      return { scope: body.scope ?? ModelRoutingScope.Global, clusterTenant: body.clusterTenant ?? null };
    }

    const row = await prisma.providerCredential.findUnique({ where: { id: String(req.params.id) } });
    if (!row)
    {
      return null;
    }
    return { scope: row.scope === "ClusterTenant" ? ModelRoutingScope.ClusterTenant : ModelRoutingScope.Global, clusterTenant: row.clusterTenant };
  });

  router.post("/", guard);
  router.put("/:id", guard);
  router.delete("/:id", guard);

  /** List provider credentials, optionally filtered to one ClusterTenant. */
  router.get("/", async function _listProviderCredentials(req, res)
  {
    const clusterTenant = typeof req.query.clusterTenant === "string" ? req.query.clusterTenant : undefined;
    const rows = await prisma.providerCredential.findMany({
      where: clusterTenant ? { clusterTenant } : undefined,
      orderBy: { createdAt: "asc" },
    });
    res.json(rows.map(_toContract));
  });

  /** Get a single provider credential by id. */
  router.get("/:id", async function _getProviderCredential(req, res)
  {
    const row = await prisma.providerCredential.findUnique({ where: { id: req.params.id } });
    if (!row)
    {
      res.status(404).json({ error: "Provider credential not found", code: "PROVIDER_CREDENTIAL_NOT_FOUND" });
      return;
    }
    res.json(_toContract(row));
  });

  /** Create a provider credential (reference only — never a raw key). */
  router.post("/", async function _createProviderCredential(req, res)
  {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Validate identity + the raw-key rejection up front before touching the DB.
    const error = _validateWrite(body);
    if (error)
    {
      res.status(400).json(error);
      return;
    }

    // 2. Persist the reference row; default scope to Global when omitted.
    const write = body as unknown as ProviderCredentialWrite;
    const scope = write.scope ?? ModelRoutingScope.Global;
    const created = await prisma.providerCredential.create({
      data: {
        scope: _toPrismaScope(scope),
        clusterTenant: scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null,
        provider: write.provider.trim(),
        secretRef: write.secretRef.trim(),
        litellmCredentialName: write.litellmCredentialName?.trim() || null,
      },
    });
    res.status(201).json(_toContract(created));
  });

  /** Update a provider credential. */
  router.put("/:id", async function _updateProviderCredential(req, res)
  {
    const existing = await prisma.providerCredential.findUnique({ where: { id: req.params.id } });
    if (!existing)
    {
      res.status(404).json({ error: "Provider credential not found", code: "PROVIDER_CREDENTIAL_NOT_FOUND" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Validate the full replacement body, including the raw-key rejection.
    const error = _validateWrite(body);
    if (error)
    {
      res.status(400).json(error);
      return;
    }

    // 2. Apply the validated fields; scope defaults to Global when omitted.
    const write = body as unknown as ProviderCredentialWrite;
    const scope = write.scope ?? ModelRoutingScope.Global;
    const data: Prisma.ProviderCredentialUpdateInput = {
      scope: _toPrismaScope(scope),
      clusterTenant: scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null,
      provider: write.provider.trim(),
      secretRef: write.secretRef.trim(),
      litellmCredentialName: write.litellmCredentialName?.trim() || null,
    };
    const updated = await prisma.providerCredential.update({ where: { id: req.params.id }, data });
    res.json(_toContract(updated));
  });

  /** Delete a provider credential. */
  router.delete("/:id", async function _deleteProviderCredential(req, res)
  {
    const existing = await prisma.providerCredential.findUnique({ where: { id: req.params.id } });
    if (!existing)
    {
      res.status(404).json({ error: "Provider credential not found", code: "PROVIDER_CREDENTIAL_NOT_FOUND" });
      return;
    }
    await prisma.providerCredential.delete({ where: { id: req.params.id } });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}
