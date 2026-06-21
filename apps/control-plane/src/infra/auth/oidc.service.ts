import { URL } from "node:url";

import type { Request, RequestHandler } from "express";
import session from "express-session";
import * as client from "openid-client";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";

import { ___LoadOidcAuthConfig } from "./oidc.config.js";

/** Auth mode exposed to the UI so it can decide whether login is required. */
export type ControlPlaneAuthMode = "development" | "oidc" | "token";

/** Authenticated human identity cached in the control-plane session. */
export interface ControlPlaneAuthUser
{
  /** Stable subject identifier from the identity provider. */
  sub: string;

  /** Issuer that authenticated the user. */
  issuer: string;

  /** The caller's group memberships from the OIDC groups/roles claims (empty when none). */
  groups: string[];

  /**
   * Whether the caller's groups intersect `OPENCRANE_PLATFORM_OPERATOR_GROUPS`.
   * Empty/unset config ⇒ false for everyone (fail-closed). Introspection only —
   * the API stays the enforcement point; a federated frontend uses this to decide
   * what UI to *hide*, never what it may *do*.
   *
   * TODO: this is a non-presumptuous, config-driven stopgap because OpenCrane has
   * no role model yet. A first-class role/RBAC model supersedes this flag.
   */
  isPlatformOperator: boolean;

  /**
   * Whether the caller is an organisation admin — the role allowed to curate the MCP
   * catalogue and approve servers (`requireOrgAdmin`, P0.5). Derived from the caller's
   * groups intersecting `OPENCRANE_ORG_ADMIN_GROUPS`; platform operators are always org
   * admins (superset). Empty/unset config ⇒ false for everyone (fail-closed). Enforcement
   * stays at the API; a federated frontend uses this only to decide what UI to hide.
   */
  isOrgAdmin: boolean;

  /** Human-readable email address when available. */
  email?: string;

  /** Whether the provider marked the email as verified. */
  emailVerified?: boolean;

  /** Display name when available. */
  name?: string;

  /** Avatar image URL when available. */
  picture?: string;

  /** ISO timestamp of when the local session was established. */
  authenticatedAt: string;
}

/**
 * Authenticated user as returned by `/auth/me`: the cached session identity plus
 * the caller's `clusterTenant`, resolved fresh at read time from their IdP-verified
 * email (never stored at login, since the email→tenant mapping can change after).
 */
export interface ControlPlaneAuthStatusUser extends ControlPlaneAuthUser
{
  /**
   * The caller's ClusterTenant (customer) key, resolved server-side from their
   * verified email → tenant → `clusterTenantRef`. Null when unresolved or ambiguous
   * (fail-closed; never taken from request input or a self-asserted claim).
   */
  clusterTenant: string | null;
}

/** Session auth status returned to the SPA bootstrap logic. */
export interface ControlPlaneAuthStatus
{
  /** Effective auth mode for the current server configuration. */
  mode: ControlPlaneAuthMode;

  /** Whether a human session is currently established. */
  authenticated: boolean;

  /** Authenticated user details when logged in through OIDC. */
  user: ControlPlaneAuthStatusUser | null;
}

/** OIDC session helper that owns provider discovery, login redirects, and session state. */
export class OidcAuthService
{
  /** Runtime OIDC configuration loaded from environment variables. */
  private config = ___LoadOidcAuthConfig();

  /** Logger used for auth lifecycle diagnostics. */
  private log: Logger;

  /** Lazily initialized OIDC client configuration discovered from the issuer. */
  private discoveredConfig: Promise<client.Configuration> | null = null;

  /** Prisma client used to resolve the caller's ClusterTenant by verified email. */
  private prisma: PrismaClient;

  /**
   * Create a new OIDC auth service bound to the current runtime config.
   * @param log    - Parent logger; a child scoped to `oidc-auth` is derived.
   * @param prisma - Prisma client for the fail-closed email→tenant→clusterTenantRef lookup.
   */
  constructor(log: Logger, prisma: PrismaClient)
  {
    this.log = log.child({ component: "oidc-auth" });
    this.prisma = prisma;
  }

  /** Whether human login should use OIDC-backed sessions. */
  isEnabled(): boolean
  {
    return this.config.enabled;
  }

  /** Build the Express session middleware required by the OIDC login flow. */
  createSessionMiddleware(): RequestHandler
  {
    if (!this.config.enabled)
    {
      return function _skipSession(req, res, next)
      {
        next();
      };
    }

    return session({
      name: this.config.cookieName,
      secret: this.config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      proxy: true,
      unset: "destroy",
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: this.config.cookieSecure,
        maxAge: this.config.sessionMaxAgeMs,
      },
    });
  }

  /**
   * Return the auth mode and current human session details for the SPA.
   *
   * Surfaces introspection-only authorization facts: the caller's `groups`,
   * the derived `isPlatformOperator`, and their `clusterTenant`. The first two
   * come from the session (resolved at login); `clusterTenant` is resolved fresh
   * here from the IdP-verified email so a post-login reparent is reflected.
   */
  async getStatus(req: Request): Promise<ControlPlaneAuthStatus>
  {
    if (this.config.enabled)
    {
      // 1. No session → unauthenticated; never resolve a tenant for an absent caller.
      const authUser = req.session.authUser;
      if (!authUser)
      {
        return { mode: "oidc", authenticated: false, user: null };
      }

      // 2. Resolve the ClusterTenant from the session's verified email (fail-closed)
      //    and return it alongside the cached identity facts.
      const clusterTenant = await this._resolveClusterTenant(authUser.email);
      return {
        mode: "oidc",
        authenticated: true,
        user: { ...authUser, clusterTenant },
      };
    }

    if ((process.env.OPENCRANE_API_TOKEN?.trim() ?? "") !== "")
    {
      return {
        mode: "token",
        authenticated: false,
        user: null,
      };
    }

    return {
      mode: "development",
      authenticated: false,
      user: null,
    };
  }

  /**
   * Resolve the caller's ClusterTenant from their IdP-verified email, reusing the
   * pod-token broker's fail-closed rule: resolve the tenant by email, then read its
   * `clusterTenantRef`. Returns null when the email is missing, matches no tenant,
   * matches more than one (ambiguous), the tenant has no parent, or the lookup
   * fails — never an arbitrary pick, and never taken from request input.
   *
   * @param email - The session's verified email claim, if any.
   */
  private async _resolveClusterTenant(email: string | undefined): Promise<string | null>
  {
    const normalized = typeof email === "string" ? email.toLowerCase().trim() : "";
    if (!normalized)
    {
      return null;
    }

    try
    {
      // Fail closed on an ambiguous email→tenant mapping: take at most two rows so a
      // duplicate is detected without silently adopting one tenant's parent.
      const matches = await this.prisma.tenant.findMany({
        where: { email: { equals: normalized, mode: "insensitive" } },
        select: { clusterTenantRef: true },
        take: 2,
      });
      if (matches.length !== 1)
      {
        return null;
      }
      return matches[0].clusterTenantRef ?? null;
    }
    catch (err)
    {
      this.log.warn({ err }, "failed to resolve clusterTenant for /auth/me; returning null");
      return null;
    }
  }

  /** Build the provider redirect URL and persist PKCE state in the local session. */
  async buildLoginUrl(req: Request, returnTo: string): Promise<string>
  {
    const discoveredConfig = await this._getDiscoveredConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const sanitizedReturnTo = _sanitizeReturnTo(returnTo);

    // 1. Persist the PKCE and replay-protection values into the signed session.
    req.session.oidcFlow = {
      codeVerifier,
      state,
      nonce,
      returnTo: sanitizedReturnTo,
    };
    await _saveSession(req);

    // 2. Build a generic OIDC authorization redirect that works with Google or any other issuer.
    const loginUrl = client.buildAuthorizationUrl(discoveredConfig, {
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    // 3. Return the URL so the router can redirect the browser.
    return loginUrl.href;
  }

  /** Complete the OIDC callback, validate claims, and establish a local session. */
  async completeLogin(req: Request): Promise<string>
  {
    const flow = req.session.oidcFlow;
    if (!flow)
    {
      throw new Error("OIDC callback arrived without an in-flight login session");
    }

    // 1. Exchange the authorization code for tokens using the stored PKCE verifier.
    const discoveredConfig = await this._getDiscoveredConfig();
    const tokens = await client.authorizationCodeGrant(discoveredConfig, _buildCurrentUrl(req), {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });

    // 2. Resolve the final set of identity claims and validate them against local allowlists.
    const claims = tokens.claims() as Record<string, unknown>;
    const mergedClaims = await this._resolveClaims(discoveredConfig, tokens.access_token, claims);
    const authUser = this._buildAuthUser(mergedClaims);
    const returnTo = _sanitizeReturnTo(flow.returnTo);

    // 3. Regenerate the session to prevent fixation, then persist the authenticated user.
    await _regenerateSession(req);
    req.session.authUser = authUser;
    await _saveSession(req);

    return returnTo;
  }

  /** Destroy the current local session during logout. */
  async logout(req: Request): Promise<void>
  {
    await _destroySession(req);
  }

  /** Discover and memoize the provider metadata and client configuration. */
  private async _getDiscoveredConfig(): Promise<client.Configuration>
  {
    if (!this.config.enabled)
    {
      throw new Error("OIDC is not configured for this control-plane instance");
    }

    if (!this.discoveredConfig)
    {
      this.discoveredConfig = this.config.clientSecret
        ? client.discovery(new URL(this.config.issuerUrl), this.config.clientId, this.config.clientSecret)
        : client.discovery(new URL(this.config.issuerUrl), this.config.clientId);
    }

    return await this.discoveredConfig;
  }

  /** Merge ID token claims with UserInfo claims when an access token is available. */
  private async _resolveClaims(
    discoveredConfig: client.Configuration,
    accessToken: string | undefined,
    claims: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  {
    if (!accessToken || typeof claims.sub !== "string")
    {
      return claims;
    }

    try
    {
      const userInfo = await client.fetchUserInfo(discoveredConfig, accessToken, claims.sub);
      return { ...claims, ...userInfo };
    }
    catch (err)
    {
      this.log.warn({ err }, "failed to fetch OIDC userinfo; continuing with ID token claims only");
      return claims;
    }
  }

  /** Validate the resolved claims and project them into the local session user shape. */
  private _buildAuthUser(claims: Record<string, unknown>): ControlPlaneAuthUser
  {
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (!subject)
    {
      throw new Error("OIDC login succeeded without a usable subject claim");
    }

    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
    const emailVerified = typeof claims.email_verified === "boolean" ? claims.email_verified : undefined;

    if ((this.config.allowedEmailDomains.length || this.config.allowedEmails.length) && !email)
    {
      throw new Error("An email claim is required for the configured OIDC allowlist");
    }

    if (emailVerified === false)
    {
      throw new Error("OIDC login was rejected because the email claim is not verified");
    }

    if (email && this.config.allowedEmails.length && !this.config.allowedEmails.includes(email))
    {
      const domain = email.split("@")[1] ?? "";
      if (!this.config.allowedEmailDomains.includes(domain))
      {
        throw new Error(`OIDC login is not allowed for ${email}`);
      }
    }

    if (email && !this.config.allowedEmails.length && this.config.allowedEmailDomains.length)
    {
      const domain = email.split("@")[1] ?? "";
      if (!this.config.allowedEmailDomains.includes(domain))
      {
        throw new Error(`OIDC login is not allowed for ${email}`);
      }
    }

    const identity = _ResolveIdentityClaims(claims, this.config);

    return {
      sub: subject,
      issuer: this.config.issuerUrl,
      groups: identity.groups,
      isPlatformOperator: identity.isPlatformOperator,
      isOrgAdmin: identity.isOrgAdmin,
      ...(email ? { email } : {}),
      ...(emailVerified !== undefined ? { emailVerified } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.picture === "string" ? { picture: claims.picture } : {}),
      authenticatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Project the IdP's group/role claims into the introspection-only authorization
 * facts the control-plane surfaces: the caller's `groups` and a derived
 * `isPlatformOperator`. Pure (no I/O) so it is unit-testable and so the rule
 * "operator iff a group matches a configured operator group" is verified
 * independently of the OIDC flow.
 *
 * `clusterTenant` is intentionally NOT derived here — it is resolved server-side
 * from the verified email → tenant → `clusterTenantRef` (see `_resolveClusterTenant`),
 * never from a self-asserted claim.
 *
 * TODO: this is the non-presumptuous stopgap until OpenCrane has a first-class
 * role model; a real RBAC model supersedes `isPlatformOperator`.
 *
 * @param claims - The merged ID-token + UserInfo claims for the caller.
 * @param config - OIDC config supplying the claim names and operator group set.
 */
export function _ResolveIdentityClaims(
  claims: Record<string, unknown>,
  config: { groupsClaim: string; rolesClaim: string; platformOperatorGroups: string[]; orgAdminGroups: string[] },
): { groups: string[]; isPlatformOperator: boolean; isOrgAdmin: boolean }
{
  // 1. Collect the raw values from both the groups and roles claims — Entra emits
  //    security groups under `groups` and app roles under `roles`; either may
  //    grant operator status, so the union is what we authorize against.
  const groups = [..._ReadStringArrayClaim(claims[config.groupsClaim]), ..._ReadStringArrayClaim(claims[config.rolesClaim])];
  const lowered = groups.map(value => value.toLowerCase());

  // 2. An empty operator set means nobody is a platform operator — fail-closed.
  const operatorSet = new Set(config.platformOperatorGroups);
  const isPlatformOperator = operatorSet.size > 0 && lowered.some(value => operatorSet.has(value));

  // 3. Org admin iff a group matches the org-admin set (fail-closed when unset).
  //    Platform operators are always org admins — operator is the broader role.
  const orgAdminSet = new Set(config.orgAdminGroups);
  const isOrgAdmin = isPlatformOperator || (orgAdminSet.size > 0 && lowered.some(value => orgAdminSet.has(value)));

  return { groups, isPlatformOperator, isOrgAdmin };
}

/**
 * Normalize a claim value into a list of non-empty strings. Identity providers
 * emit group/role claims as either an array or a single space-/comma-free
 * string, so both shapes are accepted; anything else yields an empty list.
 *
 * @param value - The raw claim value.
 */
function _ReadStringArrayClaim(value: unknown): string[]
{
  if (Array.isArray(value))
  {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  }

  if (typeof value === "string" && value.trim() !== "")
  {
    return [value.trim()];
  }

  return [];
}

/**
 * Create the singleton-friendly OIDC auth service used by the Express app.
 * @param log    - Parent logger.
 * @param prisma - Prisma client for the fail-closed email→tenant→clusterTenantRef lookup.
 */
export function ___CreateOidcAuthService(log: Logger, prisma: PrismaClient): OidcAuthService
{
  return new OidcAuthService(log, prisma);
}

/** Convert the current Express request into an absolute callback URL. */
function _buildCurrentUrl(req: Request): URL
{
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const protocol = typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim() : req.protocol;
  const host = typeof forwardedHost === "string" ? forwardedHost.split(",")[0].trim() : req.get("host");

  return new URL(`${protocol}://${host}${req.originalUrl}`);
}

/** Limit return targets to local relative paths to prevent open redirects. */
function _sanitizeReturnTo(returnTo: string | undefined): string
{
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//"))
  {
    return "/";
  }

  return returnTo;
}

/** Persist the current session mutation before redirecting. */
function _saveSession(req: Request): Promise<void>
{
  return new Promise<void>((resolve, reject) =>
  {
    req.session.save(err =>
    {
      if (err)
      {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

/** Regenerate the session identifier after login to prevent fixation. */
function _regenerateSession(req: Request): Promise<void>
{
  return new Promise<void>((resolve, reject) =>
  {
    req.session.regenerate(err =>
    {
      if (err)
      {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

/** Destroy the current session and clear its cookie. */
function _destroySession(req: Request): Promise<void>
{
  return new Promise<void>((resolve, reject) =>
  {
    req.session.destroy(err =>
    {
      if (err)
      {
        reject(err);
        return;
      }

      resolve();
    });
  });
}