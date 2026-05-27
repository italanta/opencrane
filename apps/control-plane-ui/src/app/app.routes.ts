import type { Routes } from "@angular/router";

import { authGuard } from "./core/auth/auth.guard";
import { AccessTokensPageComponent } from "./features/access-tokens/access-tokens-page.component";
import { AdminPanelPageComponent } from "./features/admin/admin-panel-page.component";
import { DashboardPageComponent } from "./features/dashboard/dashboard-page.component";
import { McpServersPageComponent } from "./features/mcp-servers/mcp-servers-page.component";
import { ProvisionPageComponent } from "./features/provision/provision-page.component";
import { ProviderKeysPageComponent } from "./features/provider-keys/provider-keys-page.component";
import { SchedulesPageComponent } from "./features/schedules/schedules-page.component";
import { ServerStatsPageComponent } from "./features/server-stats/server-stats-page.component";
import { SkillCatalogPageComponent } from "./features/skill-catalog/skill-catalog-page.component";
import { TenantDetailPageComponent } from "./features/tenant-detail/tenant-detail-page.component";
import { TokenUsagePageComponent } from "./features/token-usage/token-usage-page.component";

/** Application routes for feature pages. */
export const appRoutes: Routes = [
  { path: "", pathMatch: "full", redirectTo: "dashboard" },
  { path: "dashboard", component: DashboardPageComponent, canActivate: [authGuard] },
  { path: "provision", component: ProvisionPageComponent, canActivate: [authGuard] },
  { path: "tenants/:name", component: TenantDetailPageComponent, canActivate: [authGuard] },
  { path: "admin", component: AdminPanelPageComponent, canActivate: [authGuard] },
  { path: "mcp-servers", component: McpServersPageComponent, canActivate: [authGuard] },
  { path: "skills", component: SkillCatalogPageComponent, canActivate: [authGuard] },
  { path: "schedules", component: SchedulesPageComponent, canActivate: [authGuard] },
  { path: "stats", component: ServerStatsPageComponent, canActivate: [authGuard] },
  { path: "usage", component: TokenUsagePageComponent, canActivate: [authGuard] },
  { path: "tokens", component: AccessTokensPageComponent, canActivate: [authGuard] },
  { path: "providers", component: ProviderKeysPageComponent, canActivate: [authGuard] },
];
