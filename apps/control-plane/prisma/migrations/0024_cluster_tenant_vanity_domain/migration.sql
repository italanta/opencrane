-- Migration 0024: ClusterTenant vanity domain (fixed wildcard topology)
--
-- The platform now owns ONE fixed wildcard base; an org's serving domain is DERIVED
-- as <name>.<platformBaseDomain> (and its users at <user>.<name>.<base>), so the org
-- no longer brings its own base domain. The old customer-owned `base_domain` column
-- is repurposed as `vanity_domain`: an OPTIONAL customer-vanity domain CNAMEd onto
-- the derived org apex (an overlay, not the org identity). Existing values carry over
-- unchanged (a rename preserves data), so any previously-set domain is retained as a
-- vanity overlay until reviewed.

ALTER TABLE "cluster_tenants"
  RENAME COLUMN "base_domain" TO "vanity_domain";
