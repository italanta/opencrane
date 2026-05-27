import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { firstValueFrom } from "rxjs";

import type { ThirdPartySource } from "../models/third-party-source.model";

/** API service for third-party source discovery and scheduler status. */
@Injectable({ providedIn: "root" })
export class ThirdPartySourcesService
{
  private readonly _http = inject(HttpClient);
  private readonly _baseUrl = "/api/third-party-sources";

  /** List configured third-party sources and their sync health. */
  listThirdPartySources$(): Observable<ThirdPartySource[]>
  {
    return this._http.get<ThirdPartySource[]>(this._baseUrl);
  }

  /** List configured third-party sources and their sync health. */
  async listThirdPartySources(): Promise<ThirdPartySource[]>
  {
    return await firstValueFrom(this.listThirdPartySources$());
  }
}
