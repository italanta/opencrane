/**
 * The bound-namespace naming contract shared between the control plane and the
 * operator. The operator's ClusterTenant reconciler binds every in-cluster org to
 * the deterministic namespace `opencrane-<org>` (see the operator's
 * `_NamespaceForOrg`); the control plane re-derives the same name here so routing
 * decisions (e.g. the identity-routing gateway proxy's target) never need a live
 * cluster read. The `opencrane-` prefix is the cross-app boundary contract — keep
 * these two derivations in lockstep.
 */

/** Prefix applied to an org key to derive its bound namespace. */
const _NAMESPACE_PREFIX = "opencrane-";

/**
 * Derive the namespace bound to an org (ClusterTenant) key.
 *
 * @param org - The org / ClusterTenant key.
 * @returns The `opencrane-<org>` namespace name.
 */
export function _NamespaceForOrg(org: string): string
{
  return `${_NAMESPACE_PREFIX}${org}`;
}
