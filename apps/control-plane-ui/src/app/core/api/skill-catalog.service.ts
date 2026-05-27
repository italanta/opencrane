import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { firstValueFrom } from "rxjs";

import type { SkillBundle } from "../models/skill-bundle.model";

/** API service for the registry-backed skill catalog. */
@Injectable({ providedIn: "root" })
export class SkillCatalogService
{
  private readonly _http = inject(HttpClient);
  private readonly _baseUrl = "/api/skills/catalog";

  /** List all skill bundles visible in the catalog. */
  listSkillBundles$(): Observable<SkillBundle[]>
  {
    return this._http.get<SkillBundle[]>(this._baseUrl);
  }

  /** List all skill bundles visible in the catalog. */
  async listSkillBundles(): Promise<SkillBundle[]>
  {
    return await firstValueFrom(this.listSkillBundles$());
  }
}
