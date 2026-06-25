import "express-session";

declare module "express-session"
{
  interface SessionData
  {
    // Keep in sync with `ControlPlaneAuthUser` in oidc.service.ts.
    // Note: clusterTenant is NOT stored here — it is resolved fresh from the DB in
    // getStatus (email→tenant→clusterTenantRef), never from the session or a claim.
    authUser?: {
      sub: string;
      issuer: string;
      groups: string[];
      isPlatformOperator: boolean;
      isOrgAdmin: boolean;
      email?: string;
      emailVerified?: boolean;
      name?: string;
      picture?: string;
      authenticatedAt: string;
    };
    // ID token captured at login; used as `id_token_hint` when building the
    // IdP's end_session URL for RP-initiated logout. Never read for authorization.
    idToken?: string;
    oidcFlow?: {
      codeVerifier: string;
      state: string;
      nonce: string;
      returnTo: string;
      // Per-org OIDC client_id resolved at buildLoginUrl from the request host (S3b).
      // Persisted so completeLogin exchanges the code against the SAME client the
      // authorization request used. Absent ⇒ the masters client (platform host or an
      // unprovisioned/unknown org host that fell through fail-closed).
      clientId?: string;
    };
  }
}