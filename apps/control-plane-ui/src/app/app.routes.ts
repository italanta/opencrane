import type { Routes } from "@angular/router";

import { authGuard } from "./core/auth/auth.guard";
import { AccessTokensPageComponent } from "./features/access-tokens/access-tokens-page.component";
import { ProviderKeysPageComponent } from "./features/provider-keys/provider-keys-page.component";
import { ServerStatsPageComponent } from "./features/server-stats/server-stats-page.component";
import { TokenUsagePageComponent } from "./features/token-usage/token-usage-page.component";

/** Application routes for feature pages. */
export const appRoutes: Routes = [
  { path: "", pathMatch: "full", redirectTo: "stats" },
  { path: "stats", component: ServerStatsPageComponent, canActivate: [authGuard] },
  { path: "usage", component: TokenUsagePageComponent, canActivate: [authGuard] },
  { path: "tokens", component: AccessTokensPageComponent, canActivate: [authGuard] },
  { path: "providers", component: ProviderKeysPageComponent, canActivate: [authGuard] },
];
