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
    oidcFlow?: {
      codeVerifier: string;
      state: string;
      nonce: string;
      returnTo: string;
    };
  }
}