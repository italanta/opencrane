import { URL } from "node:url";

import type { Request, RequestHandler } from "express";
import session from "express-session";
import * as client from "openid-client";
import type { Logger } from "pino";

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

/** Session auth status returned to the SPA bootstrap logic. */
export interface ControlPlaneAuthStatus
{
  /** Effective auth mode for the current server configuration. */
  mode: ControlPlaneAuthMode;

  /** Whether a human session is currently established. */
  authenticated: boolean;

  /** Authenticated user details when logged in through OIDC. */
  user: ControlPlaneAuthUser | null;
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

  /** Create a new OIDC auth service bound to the current runtime config. */
  constructor(log: Logger)
  {
    this.log = log.child({ component: "oidc-auth" });
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

  /** Return the auth mode and current human session details for the SPA. */
  getStatus(req: Request): ControlPlaneAuthStatus
  {
    if (this.config.enabled)
    {
      return {
        mode: "oidc",
        authenticated: Boolean(req.session.authUser),
        user: req.session.authUser ?? null,
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

    return {
      sub: subject,
      issuer: this.config.issuerUrl,
      ...(email ? { email } : {}),
      ...(emailVerified !== undefined ? { emailVerified } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.picture === "string" ? { picture: claims.picture } : {}),
      authenticatedAt: new Date().toISOString(),
    };
  }
}

/** Create the singleton-friendly OIDC auth service used by the Express app. */
export function ___CreateOidcAuthService(log: Logger): OidcAuthService
{
  return new OidcAuthService(log);
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