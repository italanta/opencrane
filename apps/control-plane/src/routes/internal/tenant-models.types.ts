/**
 * Data shapes for the internal tenant-models allowlist endpoint.
 *
 * The operator fetches this at reconcile to learn the set of models a tenant
 * may use and which model is the tenant's effective default. It is a read-only,
 * best-effort projection over the model registry; it carries no secret material.
 */

/**
 * Response returned by `GET /api/internal/tenant-models/:tenant`.
 *
 * Describes the model allowlist for a single tenant and its resolved default.
 * The operator uses `models` to scope the tenant's virtual-key `models[]`
 * allowlist and `defaultModel` to seed the tenant's fallback routing.
 */
export interface TenantModelsResponse
{
  /**
   * De-duplicated `publicModelName`s the tenant may use: all Global models plus
   * any ClusterTenant-scoped models bound to the tenant's ClusterTenant.
   */
  models: string[];

  /**
   * The tenant's effective default model `publicModelName`, or null when no
   * default resolves anywhere in the precedence chain.
   */
  defaultModel: string | null;
}
