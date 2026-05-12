import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { catchError, throwError } from "rxjs";

import { AuthService } from "./auth.service";

/** Redirect users back through OIDC when the backend session expires mid-navigation. */
export const authRedirectInterceptor: HttpInterceptorFn = (req, next) =>
{
  const authService = inject(AuthService);

  return next(req).pipe(
    catchError(err =>
    {
      if (
        err instanceof HttpErrorResponse
        && err.status === 401
        && req.url.startsWith("/api/")
        && !req.url.startsWith("/api/auth")
        && authService.status()?.mode === "oidc"
      )
      {
        authService.startLogin(`${window.location.pathname}${window.location.search}`);
      }

      return throwError(() => err);
    }),
  );
};