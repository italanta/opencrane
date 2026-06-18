import { Router } from "express";
import { ModelRoutingScope } from "@opencrane/contracts";
import type { ModelDefinition, ModelDefinitionWrite } from "@opencrane/contracts";
import type { Prisma, PrismaClient, ModelDefinition as PrismaModelDefinition } from "@prisma/client";

import { _ClusterTenantScopeGuard } from "../infra/middleware/cluster-tenant-scope.js";
import type { ClusterTenantScopedResource } from "../infra/middleware/cluster-tenant-scope.types.js";
import { _RegisterLiteLlmModel } from "../core/model-routing/litellm-model-registration.js";

/**
 * Project a persisted model-definition row into its contract DTO. The Prisma enum values map
 * 1:1 to the lowercase {@link ModelRoutingScope} string union.
 *
 * @param row - The persisted `ModelDefinition` row.
 * @returns The contract-shaped model definition (timestamps as ISO-8601 strings).
 */
function _toContract(row: PrismaModelDefinition): ModelDefinition
{
  return {
    id: row.id,
    scope: row.scope === "ClusterTenant" ? ModelRoutingScope.ClusterTenant : ModelRoutingScope.Global,
    clusterTenant: row.clusterTenant,
    publicModelName: row.publicModelName,
    litellmModelId: row.litellmModelId,
    upstreamModel: row.upstreamModel,
    apiBase: row.apiBase,
    isDefault: row.isDefault,
    providerCredentialId: row.providerCredentialId,
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
 * Validate a {@link ModelDefinitionWrite} body. Returns a `{ error, code }` envelope when
 * invalid, or null when acceptable. Enforces required `publicModelName` + `upstreamModel`,
 * a valid scope, and `clusterTenant` when scope is `clusterTenant`.
 *
 * @param body - The untrusted request body.
 * @returns A `{ error, code }` payload when invalid; null when valid.
 */
function _validateWrite(body: Record<string, unknown>): { error: string; code: string } | null
{
  // 1. The routable slug and the upstream model are both required.
  const publicModelName = typeof body.publicModelName === "string" ? body.publicModelName.trim() : "";
  const upstreamModel = typeof body.upstreamModel === "string" ? body.upstreamModel.trim() : "";
  if (!publicModelName || !upstreamModel)
  {
    return { error: "publicModelName and upstreamModel are required.", code: "VALIDATION_ERROR" };
  }

  // 2. Scope must be one of the two known values when present.
  const scope = body.scope ?? ModelRoutingScope.Global;
  if (scope !== ModelRoutingScope.Global && scope !== ModelRoutingScope.ClusterTenant)
  {
    return { error: "scope must be 'global' or 'clusterTenant'.", code: "VALIDATION_ERROR" };
  }

  // 3. A ClusterTenant-scoped model must name its owning clusterTenant.
  if (scope === ModelRoutingScope.ClusterTenant && !(typeof body.clusterTenant === "string" && body.clusterTenant.trim()))
  {
    return { error: "clusterTenant is required when scope is 'clusterTenant'.", code: "VALIDATION_ERROR" };
  }

  return null;
}

/**
 * Resolve and scope-check the backing credential for a model write. A model may bind only a
 * Global credential or one owned by its OWN ClusterTenant — never another customer's — which
 * stops a tenant-scoped model from borrowing another ClusterTenant's provider key. Shared by
 * create and update so the isolation rule cannot be bypassed via PUT.
 *
 * @param prisma - Prisma client used to look up the credential.
 * @param providerCredentialId - The requested credential id, or undefined/null when none.
 * @param modelClusterTenant - The owning ClusterTenant of the model (null for Global scope).
 * @returns `{ secretRef }` (null when no credential requested), or a `{ error, code }` envelope.
 */
async function _resolveCredential(prisma: PrismaClient, providerCredentialId: string | null | undefined, modelClusterTenant: string | null): Promise<{ secretRef: string | null } | { error: string; code: string }>
{
  if (!providerCredentialId)
  {
    return { secretRef: null };
  }
  const credential = await prisma.providerCredential.findUnique({ where: { id: providerCredentialId } });
  if (!credential)
  {
    return { error: "providerCredentialId does not reference an existing credential.", code: "VALIDATION_ERROR" };
  }
  const credentialClusterTenant = credential.scope === "ClusterTenant" ? credential.clusterTenant : null;
  if (credentialClusterTenant && credentialClusterTenant !== modelClusterTenant)
  {
    return { error: "providerCredentialId is owned by a different ClusterTenant.", code: "CREDENTIAL_SCOPE_MISMATCH" };
  }
  return { secretRef: credential.secretRef };
}

/**
 * CRUD router for {@link ModelDefinition} — routable models registered in LiteLLM (BYOM).
 *
 * On create the row is persisted and the model is registered GLOBALLY with LiteLLM via a
 * best-effort `POST /model/new` (guarded by `LITELLM_ENDPOINT` + `LITELLM_MASTER_KEY`); when
 * LiteLLM is unconfigured a deterministic placeholder id is stored and the create still
 * succeeds. Mutations are gated by the ClusterTenant scope guard (AIR.0b).
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function modelRegistryRouter(prisma: PrismaClient): Router
{
  const router = Router();

  // Mutation guard: resolve the targeted model's scope so the guard can decide. For POST the
  // scope comes from the body; for PUT/DELETE from the persisted row.
  const guard = _ClusterTenantScopeGuard(prisma, async function _resolveResource(req): Promise<ClusterTenantScopedResource | null>
  {
    if (req.method === "POST")
    {
      const body = (req.body ?? {}) as ModelDefinitionWrite;
      return { scope: body.scope ?? ModelRoutingScope.Global, clusterTenant: body.clusterTenant ?? null };
    }

    const row = await prisma.modelDefinition.findUnique({ where: { id: String(req.params.id) } });
    if (!row)
    {
      return null;
    }
    return { scope: row.scope === "ClusterTenant" ? ModelRoutingScope.ClusterTenant : ModelRoutingScope.Global, clusterTenant: row.clusterTenant };
  });

  router.post("/", guard);
  router.put("/:id", guard);
  router.delete("/:id", guard);

  /** List model definitions, optionally filtered to one ClusterTenant. */
  router.get("/", async function _listModels(req, res)
  {
    const clusterTenant = typeof req.query.clusterTenant === "string" ? req.query.clusterTenant : undefined;
    const rows = await prisma.modelDefinition.findMany({
      where: clusterTenant ? { clusterTenant } : undefined,
      orderBy: { createdAt: "asc" },
    });
    res.json(rows.map(_toContract));
  });

  /** Get a single model definition by id. */
  router.get("/:id", async function _getModel(req, res)
  {
    const row = await prisma.modelDefinition.findUnique({ where: { id: req.params.id } });
    if (!row)
    {
      res.status(404).json({ error: "Model definition not found", code: "MODEL_DEFINITION_NOT_FOUND" });
      return;
    }
    res.json(_toContract(row));
  });

  /** Create a model definition, registering it best-effort with LiteLLM. */
  router.post("/", async function _createModel(req, res)
  {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Validate the body before any persistence or upstream call.
    const error = _validateWrite(body);
    if (error)
    {
      res.status(400).json(error);
      return;
    }

    const write = body as unknown as ModelDefinitionWrite;
    const scope = write.scope ?? ModelRoutingScope.Global;

    // 2. Resolve + scope-check the backing credential (when set) — see _resolveCredential.
    const credentialResult = await _resolveCredential(prisma, write.providerCredentialId, scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null);
    if ("error" in credentialResult)
    {
      res.status(400).json(credentialResult);
      return;
    }
    const apiKeyEnvRef = credentialResult.secretRef;

    // 3. Best-effort LiteLLM registration; returns a deterministic placeholder when unconfigured.
    const litellmModelId = await _RegisterLiteLlmModel({
      publicModelName: write.publicModelName.trim(),
      upstreamModel: write.upstreamModel.trim(),
      scope,
      clusterTenant: scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null,
      apiBase: write.apiBase?.trim() || null,
      apiKeyEnvRef,
    });

    // 4. Persist the row with the resolved deployment id.
    const created = await prisma.modelDefinition.create({
      data: {
        scope: _toPrismaScope(scope),
        clusterTenant: scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null,
        publicModelName: write.publicModelName.trim(),
        litellmModelId,
        upstreamModel: write.upstreamModel.trim(),
        apiBase: write.apiBase?.trim() || null,
        isDefault: write.isDefault ?? false,
        providerCredentialId: write.providerCredentialId ?? null,
      },
    });
    res.status(201).json(_toContract(created));
  });

  /** Update a model definition (does not re-register with LiteLLM). */
  router.put("/:id", async function _updateModel(req, res)
  {
    const existing = await prisma.modelDefinition.findUnique({ where: { id: req.params.id } });
    if (!existing)
    {
      res.status(404).json({ error: "Model definition not found", code: "MODEL_DEFINITION_NOT_FOUND" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Validate the full replacement body.
    const error = _validateWrite(body);
    if (error)
    {
      res.status(400).json(error);
      return;
    }

    const write = body as unknown as ModelDefinitionWrite;
    const scope = write.scope ?? ModelRoutingScope.Global;
    const modelClusterTenant = scope === ModelRoutingScope.ClusterTenant ? write.clusterTenant!.trim() : null;

    // 2. Re-validate the backing credential with the SAME scope-isolation rule as create, so a PUT
    //    cannot bind (or smuggle in) another ClusterTenant's credential.
    const credentialResult = await _resolveCredential(prisma, write.providerCredentialId, modelClusterTenant);
    if ("error" in credentialResult)
    {
      res.status(400).json(credentialResult);
      return;
    }

    // 3. Apply the validated fields; the LiteLLM deployment id is immutable here.
    const data: Prisma.ModelDefinitionUncheckedUpdateInput = {
      scope: _toPrismaScope(scope),
      clusterTenant: modelClusterTenant,
      publicModelName: write.publicModelName.trim(),
      upstreamModel: write.upstreamModel.trim(),
      apiBase: write.apiBase?.trim() || null,
      isDefault: write.isDefault ?? false,
      providerCredentialId: write.providerCredentialId ?? null,
    };
    const updated = await prisma.modelDefinition.update({ where: { id: req.params.id }, data });
    res.json(_toContract(updated));
  });

  /** Delete a model definition. */
  router.delete("/:id", async function _deleteModel(req, res)
  {
    const existing = await prisma.modelDefinition.findUnique({ where: { id: req.params.id } });
    if (!existing)
    {
      res.status(404).json({ error: "Model definition not found", code: "MODEL_DEFINITION_NOT_FOUND" });
      return;
    }
    await prisma.modelDefinition.delete({ where: { id: req.params.id } });
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}
