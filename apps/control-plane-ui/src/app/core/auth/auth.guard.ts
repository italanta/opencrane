import { inject } from "@angular/core";
import type { CanActivateFn } from "@angular/router";

import { AuthService } from "./auth.service";

/** Guard that redirects browser sessions into the OIDC login flow when required. */
export const authGuard: CanActivateFn = async (route, state) =>
{
  const authService = inject(AuthService);
  const status = await authService.ensureLoaded();

  if (status.mode !== "oidc" || status.authenticated)
  {
    return true;
  }

  authService.startLogin(state.url);
  return false;
};