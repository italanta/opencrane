/**
 * Platform domain topology — the single source of truth for how OpenCrane derives
 * org and user hostnames from one fixed platform wildcard base.
 *
 * The platform owns ONE wildcard base (`<base>`, e.g. `weownai.eu`) under which:
 *   - each org (ClusterTenant) is served at `<org>.<base>`     (the org apex)
 *   - each user (UserTenant) is served at `<user>.<org>.<base>` (the per-user gateway)
 * The fixed super-operator / control-plane host (e.g. `platform.weownai.eu`) is a
 * SEPARATE host, never derived from this base — it is the management API above every
 * org. A customer may optionally CNAME a vanity domain ONTO their `<org>.<base>` apex;
 * the vanity name is an overlay, not the canonical identity.
 *
 * Because DNS wildcards match exactly one label, `*.<base>` covers `<org>.<base>` but
 * NOT `<user>.<org>.<base>`. The per-user level needs its own `*.<org>.<base>`
 * wildcard certificate, issued per org at provision time (see
 * docs/agents/cluster-architecture.md → "Multi-level wildcard TLS").
 */

/** Lowercased, single-label DNS name (an org name or user/tenant name). */
type DnsLabel = string;

/**
 * Derive the canonical org-serving domain (the org apex) for a ClusterTenant under
 * the platform wildcard base: `<org>.<base>`. This is the domain the org's UserTenant
 * gateway hosts hang off, and the apex a customer CNAMEs a vanity domain onto.
 *
 * @param orgName - The ClusterTenant name (single DNS label, e.g. `acme`).
 * @param platformBaseDomain - The platform wildcard base (e.g. `weownai.eu`).
 * @returns The org apex domain `<org>.<base>` (e.g. `acme.weownai.eu`).
 */
export function _BuildOrgDomain(orgName: DnsLabel, platformBaseDomain: string): string
{
  return `${orgName}.${platformBaseDomain}`;
}

/**
 * Derive a UserTenant gateway host under an org domain: `<user>.<orgDomain>`. The
 * org domain is normally `<org>.<base>` (so the user lands at `<user>.<org>.<base>`),
 * but a customer-vanity domain CNAMEd onto the org apex can be passed instead so the
 * user is reachable under the vanity name too.
 *
 * @param userName - The UserTenant name (single DNS label, e.g. `mike`).
 * @param orgDomain - The org-serving domain (`<org>.<base>` or a vanity domain).
 * @returns The UserTenant host `<user>.<orgDomain>` (e.g. `mike.acme.weownai.eu`).
 */
export function _BuildUserHost(userName: DnsLabel, orgDomain: string): string
{
  return `${userName}.${orgDomain}`;
}

/**
 * Derive the per-org wildcard DNS name whose certificate covers every UserTenant
 * gateway host under the org: `*.<orgDomain>`. cert-manager issues this per org at
 * provision time via DNS-01, because the platform `*.<base>` cert does NOT reach the
 * extra label `<user>.<org>.<base>`.
 *
 * @param orgDomain - The org-serving domain (`<org>.<base>`).
 * @returns The per-org wildcard name `*.<orgDomain>` (e.g. `*.acme.weownai.eu`).
 */
export function _BuildOrgWildcard(orgDomain: string): string
{
  return `*.${orgDomain}`;
}
