import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { firstValueFrom } from "rxjs";

import type { Group } from "../models/group.model";

/** API service for domain groups and entitlement targets. */
@Injectable({ providedIn: "root" })
export class GroupsService
{
  private readonly _http = inject(HttpClient);
  private readonly _baseUrl = "/api/groups";

  /** List all groups visible to the current operator. */
  listGroups$(): Observable<Group[]>
  {
    return this._http.get<Group[]>(this._baseUrl);
  }

  /** List all groups visible to the current operator. */
  async listGroups(): Promise<Group[]>
  {
    return await firstValueFrom(this.listGroups$());
  }
}
