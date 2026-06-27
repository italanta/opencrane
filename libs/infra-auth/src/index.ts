/**
 * `@opencrane/infra-auth` — the OIDC login + authorization substrate shared by the
 * fleet-manager and the clustertenant-manager: env-driven OIDC config, the session-backed
 * auth service (with per-org / status-enrichment seams), identity-claim projection,
 * org-membership facts, the auth middleware, and the authorization gates.
 *
 * Importing this package also applies the `express-session` `SessionData` augmentation
 * (see ./session.types) so `req.session.authUser` is typed in every consumer.
 */
import "./session.types.js";

export { ___LoadOidcAuthConfig } from "./oidc-config.js";
export type { OidcAuthConfig } from "./oidc-config.types.js";
export { _IsDevAuthMode } from "./auth-mode.js";
export { _RequestHost } from "./request-host.js";
export { _ResolveIdentityClaims, _ReadStringArrayClaim } from "./identity-claims.js";
export {
  _buildCurrentUrl,
  _buildPostLogoutRedirectUri,
  _buildRedirectUri,
  _destroySession,
  _regenerateSession,
  _sanitizeReturnTo,
  _saveSession,
} from "./session.js";
export type { AuthUser } from "./session.js";
export {
  _ResolveOrgMembershipFacts,
} from "./org-membership.js";
export type { OrgMembershipFacts, OrgMembershipReader, OrgMembershipRow, OwnedOrg } from "./org-membership.js";
export { OidcAuthServiceBase } from "./oidc-service.js";
export type { AuthStatus, AuthStatusUser, LoginClient, ManagerAuthMode } from "./oidc-service.js";
export { ___AuthMiddleware } from "./auth-middleware.js";
export type { AccessTokenReader } from "./auth-middleware.js";
export { _RequirePlatformOperator } from "./require-platform-operator.js";
export { _RequireOrgAdmin } from "./require-org-admin.js";
export {
  _RequireBillingAccountForOrgCreate,
  _RequireOrgManager,
} from "./cluster-tenant-org-admin.js";
export type { BillingAccountReader, OrgManagerReader } from "./cluster-tenant-org-admin.js";
