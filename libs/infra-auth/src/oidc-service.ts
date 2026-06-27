import { URL } from "node:url";

import type { Request, RequestHandler } from "express";
import session from "express-session";
import * as client from "openid-client";
import type { Logger } from "pino";

import { ___LoadOidcAuthConfig } from "./oidc-config.js";
import type { OidcAuthConfig } from "./oidc-config.types.js";
import { _ResolveIdentityClaims } from "./identity-claims.js";
import { _ResolveOrgMembershipFacts } from "./org-membership.js";
import type { OrgMembershipReader, OwnedOrg } from "./org-membership.js";
import {
  _buildCurrentUrl,
  _buildPostLogoutRedirectUri,
  _buildRedirectUri,
  _destroySession,
  _regenerateSession,
  _sanitizeReturnTo,
  _saveSession,
} from "./session.js";
import type { AuthUser } from "./session.js";

/** Auth mode exposed to the UI so it can decide whether login is required. */
export type ManagerAuthMode = "development" | "oidc" | "token";

/**
 * Authenticated user as returned by `/auth/me`: the cached session identity plus the
 * membership-derived `ownedOrgs`. Subclasses may enrich it with extra fields (e.g. the
 * clustertenant-manager adds the caller's resolved `clusterTenant`) via
 * {@link OidcAuthServiceBase.enrichStatusUser}.
 */
export interface AuthStatusUser extends AuthUser
{
  /**
   * The organisations the caller owns or administers, derived fresh from `OrgMembership`
   * (owner/admin only). Empty when the caller administers no org.
   */
  ownedOrgs: OwnedOrg[];
}

/** Session auth status returned to the SPA bootstrap logic. */
export interface AuthStatus
{
  /** Effective auth mode for the current server configuration. */
  mode: ManagerAuthMode;

  /** Whether a human session is currently established. */
  authenticated: boolean;

  /** Authenticated user details when logged in through OIDC (with any subclass enrichment). */
  user: (AuthStatusUser & Record<string, unknown>) | null;
}

/** The OIDC client + scope a login should use, resolved by {@link OidcAuthServiceBase.resolveLoginClient}. */
export interface LoginClient
{
  /** The discovered OIDC client configuration to authorize against. */
  config: client.Configuration;

  /** The scope string for the authorization request. */
  scope: string;

  /** The client_id to record in the flow so token exchange uses the same client (omit ⇒ masters). */
  clientId?: string;
}

/**
 * OIDC session helper shared by both managers: owns provider discovery, the PKCE login
 * redirect, token exchange, claim validation, session lifecycle, and `/auth/me` status.
 *
 * Two seams are left for subclasses:
 *   - {@link resolveLoginClient} — which OIDC client + scope to use for a login. The base
 *     uses the single masters client; the clustertenant-manager overrides it to resolve a
 *     per-org client from the request host.
 *   - {@link enrichStatusUser} — extra `/auth/me` fields. The base adds none; the
 *     clustertenant-manager adds the caller's resolved `clusterTenant`.
 *
 * The membership-derived `ownedOrgs` + effective `isOrgAdmin` are resolved by the base for
 * both managers (both keep an `OrgMembership` table).
 */
export abstract class OidcAuthServiceBase
{
  /** Runtime OIDC configuration loaded from environment variables. */
  protected config: OidcAuthConfig = ___LoadOidcAuthConfig();

  /** Logger used for auth lifecycle diagnostics. */
  protected log: Logger;

  /** Lazily initialized OIDC client configuration discovered from the issuer (masters client). */
  private discoveredConfig: Promise<client.Configuration> | null = null;

  /** Discovered configs keyed by a specific client_id (per-org clients at the same issuer). */
  private clientDiscovered = new Map<string, Promise<client.Configuration>>();

  /** Read surface for resolving the caller's membership-derived org-admin facts. */
  protected membershipReader: OrgMembershipReader;

  /**
   * @param log              - Parent logger; a child scoped to `oidc-auth` is derived.
   * @param membershipReader - Client exposing the minimal `OrgMembership` read surface.
   */
  constructor(log: Logger, membershipReader: OrgMembershipReader)
  {
    this.log = log.child({ component: "oidc-auth" });
    this.membershipReader = membershipReader;
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
   * Return the auth mode and current human session details. Resolves the
   * membership-derived `isOrgAdmin` + `ownedOrgs` fresh (so a user who just created an org
   * is an org admin without re-login) and merges any subclass enrichment.
   */
  async getStatus(req: Request): Promise<AuthStatus>
  {
    if (this.config.enabled)
    {
      const authUser = req.session.authUser;
      if (!authUser)
      {
        return { mode: "oidc", authenticated: false, user: null };
      }

      const [membership, extra] = await Promise.all([
        _ResolveOrgMembershipFacts(this.membershipReader, authUser.sub),
        this.enrichStatusUser(req, authUser),
      ]);

      return {
        mode: "oidc",
        authenticated: true,
        user: {
          ...authUser,
          isOrgAdmin: authUser.isOrgAdmin || membership.isOrgAdmin,
          ownedOrgs: membership.ownedOrgs,
          ...extra,
        },
      };
    }

    if ((process.env.OPENCRANE_API_TOKEN?.trim() ?? "") !== "")
    {
      return { mode: "token", authenticated: false, user: null };
    }

    return { mode: "development", authenticated: false, user: null };
  }

  /** Build the provider redirect URL and persist PKCE state in the local session. */
  async buildLoginUrl(req: Request, returnTo: string): Promise<string>
  {
    // 1. Resolve which OIDC client + scope to authorize against (base = masters client).
    const login = await this.resolveLoginClient(req);

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const sanitizedReturnTo = _sanitizeReturnTo(returnTo);

    // 2. Persist the PKCE and replay-protection values, recording the resolved client_id so
    //    completeLogin exchanges the code against the SAME client (absent ⇒ masters client).
    req.session.oidcFlow = {
      codeVerifier,
      state,
      nonce,
      returnTo: sanitizedReturnTo,
      ...(login.clientId ? { clientId: login.clientId } : {}),
    };
    await _saveSession(req);

    // 3. Build a standards-only OIDC authorization redirect.
    const loginUrl = client.buildAuthorizationUrl(login.config, {
      redirect_uri: _buildRedirectUri(req, this.config.redirectUri),
      scope: login.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

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

    // 1. Exchange the authorization code against the SAME client the authorization request
    //    used: the client_id recorded in the flow (per-org), else the masters client.
    const discoveredConfig = flow.clientId ? await this.discoverForClient(flow.clientId) : await this.getDiscoveredConfig();
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
    if (typeof tokens.id_token === "string" && tokens.id_token !== "")
    {
      req.session.idToken = tokens.id_token;
    }
    await _saveSession(req);

    return returnTo;
  }

  /**
   * Destroy the current local session and, when configured, return the IdP's RP-Initiated
   * Logout URL. Returns null when OIDC is disabled, the session had no captured id_token, or
   * the IdP does not advertise an `end_session_endpoint`.
   */
  async logout(req: Request): Promise<string | null>
  {
    const endSessionUrl = await this._buildEndSessionUrl(req);
    await _destroySession(req);
    return endSessionUrl;
  }

  /**
   * Resolve the OIDC client + scope a login should use. The base uses the single masters
   * client and the configured scopes. Override to select a per-request client (e.g. per-org).
   *
   * @param _req - The incoming login request (unused by the base).
   */
  protected async resolveLoginClient(_req: Request): Promise<LoginClient>
  {
    return { config: await this.getDiscoveredConfig(), scope: this.config.scopes };
  }

  /**
   * Resolve extra `/auth/me` fields beyond the base identity + membership facts. The base
   * adds none. Override to enrich (e.g. the clustertenant-manager adds `clusterTenant`).
   *
   * @param _req      - The status request (unused by the base).
   * @param _authUser - The cached session identity (unused by the base).
   */
  protected async enrichStatusUser(_req: Request, _authUser: AuthUser): Promise<Record<string, unknown>>
  {
    return {};
  }

  /** Discover and memoize the provider metadata and client configuration (masters client). */
  protected async getDiscoveredConfig(): Promise<client.Configuration>
  {
    if (!this.config.enabled)
    {
      throw new Error("OIDC is not configured for this manager instance");
    }

    if (!this.discoveredConfig)
    {
      this.discoveredConfig = this.config.clientSecret
        ? client.discovery(new URL(this.config.issuerUrl), this.config.clientId, this.config.clientSecret)
        : client.discovery(new URL(this.config.issuerUrl), this.config.clientId);
    }

    return await this.discoveredConfig;
  }

  /**
   * Discover (and memoize) the OIDC configuration for a SPECIFIC client_id at the configured
   * issuer. Used for per-org public PKCE clients (no secret). Evicts a rejected promise so a
   * transient discovery failure is retried rather than cached for the process lifetime.
   *
   * @param clientId - The org's OIDC client_id resolved from the request host.
   */
  protected async discoverForClient(clientId: string): Promise<client.Configuration>
  {
    if (!this.config.enabled)
    {
      throw new Error("OIDC is not configured for this manager instance");
    }

    let discovered = this.clientDiscovered.get(clientId);
    if (!discovered)
    {
      discovered = client.discovery(new URL(this.config.issuerUrl), clientId);
      this.clientDiscovered.set(clientId, discovered);
    }
    try
    {
      return await discovered;
    }
    catch (err)
    {
      this.clientDiscovered.delete(clientId);
      this.log.warn({ err, clientId }, "per-client OIDC discovery failed; login is unavailable for this client");
      throw err;
    }
  }

  /**
   * Build the IdP's `end_session_endpoint` URL with `id_token_hint` and (when configured)
   * `post_logout_redirect_uri`. Returns null when not applicable — never blocks local logout.
   */
  private async _buildEndSessionUrl(req: Request): Promise<string | null>
  {
    if (!this.config.enabled)
    {
      return null;
    }

    const idToken = req.session?.idToken;
    if (typeof idToken !== "string" || idToken === "")
    {
      return null;
    }

    try
    {
      const discoveredConfig = await this.getDiscoveredConfig();
      const metadata = discoveredConfig.serverMetadata();
      if (!metadata.end_session_endpoint)
      {
        return null;
      }

      const params: Record<string, string> = { id_token_hint: idToken };
      if (this.config.postLogoutRedirectUri)
      {
        params.post_logout_redirect_uri = _buildPostLogoutRedirectUri(req, this.config.postLogoutRedirectUri);
      }

      return client.buildEndSessionUrl(discoveredConfig, params).href;
    }
    catch (err)
    {
      this.log.warn({ err }, "failed to build OIDC end-session URL; logging out locally only");
      return null;
    }
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
  private _buildAuthUser(claims: Record<string, unknown>): AuthUser
  {
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (!subject)
    {
      throw new Error("OIDC login succeeded without a usable subject claim");
    }

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
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

    const identity = _ResolveIdentityClaims(claims, this.config, email);

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
