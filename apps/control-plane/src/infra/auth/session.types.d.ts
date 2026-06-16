import "express-session";

declare module "express-session"
{
  interface SessionData
  {
    // Keep in sync with `ControlPlaneAuthUser` in oidc.service.ts.
    authUser?: {
      sub: string;
      issuer: string;
      role: "platform-operator" | "customer-admin";
      groups: string[];
      clusterTenant?: string;
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