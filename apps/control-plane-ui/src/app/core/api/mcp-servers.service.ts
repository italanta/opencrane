import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { firstValueFrom } from "rxjs";

import type { McpServer } from "../models/mcp-server.model";

/** API service for MCP server management endpoints. */
@Injectable({ providedIn: "root" })
export class McpServersService
{
  private readonly _http = inject(HttpClient);
  private readonly _baseUrl = "/api/mcp-servers";

  /** List MCP servers registered with the control-plane. */
  listMcpServers$(): Observable<McpServer[]>
  {
    return this._http.get<McpServer[]>(this._baseUrl);
  }

  /** List MCP servers registered with the control-plane. */
  async listMcpServers(): Promise<McpServer[]>
  {
    return await firstValueFrom(this.listMcpServers$());
  }
}
