import "express-session";

declare module "express-session"
{
  interface SessionData
  {
    authUser?: {
      sub: string;
      issuer: string;
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