import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideHttpClient, withFetch, withInterceptors } from "@angular/common/http";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { providePrimeNG } from "primeng/config";
import Nora from "@primeuix/themes/nora";

import { authRedirectInterceptor } from "./core/auth/auth.interceptor";
import { appRoutes } from "./app.routes";

/** Root application configuration for the control-plane dashboard. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    providePrimeNG({
      theme: {
        preset: Nora,
      },
      ripple: true,
    }),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authRedirectInterceptor])),
  ],
};
