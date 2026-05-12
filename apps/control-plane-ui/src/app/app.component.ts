import { CommonModule } from "@angular/common";
import { ButtonModule } from "primeng/button";
import { Component, OnInit, computed, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import type { MenuItem } from "primeng/api";
import { MenubarModule } from "primeng/menubar";

import { AuthService } from "./core/auth/auth.service";

/** Root shell with top navigation and router outlet. */
@Component({
  selector: "oc-root",
  standalone: true,
  imports: [ButtonModule, CommonModule, MenubarModule, RouterOutlet],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit
{
  /** Session-backed auth state shared with guards and API interceptors. */
  private readonly _authService = inject(AuthService);

  /** Live auth status for shell rendering. */
  protected readonly authStatus = this._authService.status;

  /** Best-effort display label for the current user. */
  protected readonly displayName = computed(() =>
  {
    const user = this.authStatus()?.user;
    return user?.name ?? user?.email ?? user?.sub ?? "";
  });

  protected readonly navigation: MenuItem[] = [
    { label: "Server Metrics", icon: "pi pi-chart-line", routerLink: "/stats" },
    { label: "Token Usage & Budgets", icon: "pi pi-wallet", routerLink: "/usage" },
    { label: "Access Tokens", icon: "pi pi-key", routerLink: "/tokens" },
    { label: "Provider Keys", icon: "pi pi-shield", routerLink: "/providers" },
  ];

  /** Bootstrap auth status once so the shell can render user state immediately. */
  async ngOnInit(): Promise<void>
  {
    await this._authService.ensureLoaded();
  }

  /** Sign the current user out of the local control-plane session. */
  async logout(): Promise<void>
  {
    await this._authService.logout();
  }
}
