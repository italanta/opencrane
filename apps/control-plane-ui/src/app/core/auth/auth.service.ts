import { HttpClient } from "@angular/common/http";
import { Injectable, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";

import type { AuthStatusResponse } from "../models/control-plane.models";

/** Auth gateway for the OIDC-backed control-plane session. */
@Injectable({ providedIn: "root" })
export class AuthService
{
  /** Angular HTTP client used for same-origin auth session endpoints. */
  private readonly _http = inject(HttpClient);

  /** Cached auth status loaded from `/api/auth/me`. */
  private readonly _status = signal<AuthStatusResponse | null>(null);

  /** In-flight bootstrap request so multiple guards share one fetch. */
  private _loadPromise: Promise<AuthStatusResponse> | null = null;

  /** Read-only auth status signal consumed by guards and shell components. */
  readonly status = this._status.asReadonly();

  /** Ensure auth status is loaded once before route activation. */
  async ensureLoaded(forceReload: boolean = false): Promise<AuthStatusResponse>
  {
    if (!forceReload && this._status())
    {
      return this._status()!;
    }

    if (!forceReload && this._loadPromise)
    {
      return await this._loadPromise;
    }

    this._loadPromise = this._fetchStatus();

    try
    {
      const status = await this._loadPromise;
      this._status.set(status);
      return status;
    }
    finally
    {
      this._loadPromise = null;
    }
  }

  /** Refresh auth status from the backend after logout or callback redirects. */
  async refresh(): Promise<AuthStatusResponse>
  {
    return await this.ensureLoaded(true);
  }

  /** Start browser login by redirecting to the backend OIDC entrypoint. */
  startLogin(returnTo: string): void
  {
    window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo || "/")}`);
  }

  /** Terminate the local session and return the user to the dashboard root. */
  async logout(): Promise<void>
  {
    await firstValueFrom(this._http.post("/api/auth/logout", {}));
    this._status.set({ mode: "oidc", authenticated: false, user: null });
    window.location.assign("/");
  }

  /** Fetch the current auth mode and session status from the control-plane API. */
  private async _fetchStatus(): Promise<AuthStatusResponse>
  {
    return await firstValueFrom(this._http.get<AuthStatusResponse>("/api/auth/me"));
  }
}