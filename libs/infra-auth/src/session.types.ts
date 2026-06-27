import "express-session";

import type { AuthUser } from "./session.js";

declare module "express-session"
{
  interface SessionData
  {
    /**
     * The authenticated human identity, established by the OIDC login flow and read by the
     * authorization gates. Shared shape across both managers (see {@link AuthUser}).
     */
    authUser?: AuthUser;

    /**
     * ID token captured at login; used as `id_token_hint` when building the IdP's
     * end_session URL for RP-initiated logout. Never read for authorization.
     */
    idToken?: string;

    /**
     * In-flight OIDC login state (PKCE + replay protection). `clientId` records the
     * per-org OIDC client the authorization request used so `completeLogin` exchanges the
     * code against the SAME client. The clustertenant-manager sets it (per-org login); the
     * fleet-manager leaves it unset (single client) and the base flow falls back to the
     * masters client.
     */
    oidcFlow?: {
      codeVerifier: string;
      state: string;
      nonce: string;
      returnTo: string;
      clientId?: string;
    };
  }
}

// This module exists only for the ambient `express-session` augmentation above; importing
// it for its side effect (in the package barrel) is what brings the augmentation into scope.
export {};
