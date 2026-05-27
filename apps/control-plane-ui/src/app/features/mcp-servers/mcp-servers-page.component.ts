import { Component, computed, inject } from "@angular/core";
import { rxResource } from "@angular/core/rxjs-interop";
import type { Observable } from "rxjs";
import { ButtonModule } from "primeng/button";
import { MessageModule } from "primeng/message";
import { ProgressSpinnerModule } from "primeng/progressspinner";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";

import { GroupsService } from "../../core/api/groups.service";
import { McpServersService } from "../../core/api/mcp-servers.service";
import type { Group } from "../../core/models/group.model";
import { McpServerStatus, type McpServer } from "../../core/models/mcp-server.model";
import { createEntitlementCatalogPageState } from "../shared/entitlement-catalog-page.state";
import { GrantEditorComponent } from "../../shared/components/grant-editor/grant-editor.component";
import { McpServerCardComponent } from "../../shared/components/mcp-server-card/mcp-server-card.component";
import { UiSectionCardComponent } from "../../shared/components/ui-section-card/ui-section-card.component";
import { getGrantScopeSeverity } from "../../shared/utils/grant-scope-severity";

/** Operator page for MCP server inventory and grant previews. */
@Component({
  selector: "oc-mcp-servers-page",
  standalone: true,
  imports: [
    ButtonModule,
    MessageModule,
    ProgressSpinnerModule,
    TableModule,
    TagModule,
    GrantEditorComponent,
    McpServerCardComponent,
    UiSectionCardComponent,
  ],
  templateUrl: "./mcp-servers-page.component.html",
})
export class McpServersPageComponent
{
  /** MCP server API service. */
  private readonly _mcpServersService = inject(McpServersService);

  /** Group API service. */
  private readonly _groupsService = inject(GroupsService);

  /** Resource-backed MCP server inventory. */
  private readonly _serversResource = rxResource({
    stream: this._listServers.bind(this),
    defaultValue: [],
  });

  /** Resource-backed group inventory. */
  private readonly _groupsResource = rxResource({
    stream: this._listGroups.bind(this),
    defaultValue: [],
  });

  /** Loaded MCP servers. */
  readonly _servers = computed(this._computeServers.bind(this));

  /** Loaded groups. */
  readonly _groups = computed(this._computeGroups.bind(this));

  /** Shared selection and preview state for the server catalog. */
  private readonly _catalogState = createEntitlementCatalogPageState(this._servers);

  /** Combined page loading state. */
  readonly _loading = computed(this._computeLoading.bind(this));

  /** Combined page error state. */
  readonly _error = computed(this._computeError.bind(this));

  /** Server summary subtitle. */
  readonly _serversSubtitle = computed(this._computeServersSubtitle.bind(this));

  /** Selected server details. */
  readonly _selectedServer = this._catalogState.selectedItem;

  /** Grants for the selected server, including local preview edits. */
  readonly _selectedServerGrants = this._catalogState.selectedItemGrants;

  /** Count of active servers. */
  readonly _activeCount = computed(this._computeActiveCount.bind(this));

  /** Count of degraded servers. */
  readonly _degradedCount = computed(this._computeDegradedCount.bind(this));

  /** Count of draft servers. */
  readonly _draftCount = computed(this._computeDraftCount.bind(this));

  /** Fetch the current MCP server list. */
  private _listServers(): Observable<McpServer[]>
  {
    return this._mcpServersService.listMcpServers$();
  }

  /** Fetch the current group list. */
  private _listGroups(): Observable<Group[]>
  {
    return this._groupsService.listGroups$();
  }

  /** Return the loaded MCP server list. */
  private _computeServers(): McpServer[]
  {
    return this._serversResource.value();
  }

  /** Return the loaded group list. */
  private _computeGroups(): Group[]
  {
    return this._groupsResource.value();
  }

  /** Return whether either resource is still loading. */
  private _computeLoading(): boolean
  {
    return this._serversResource.isLoading() || this._groupsResource.isLoading();
  }

  /** Return the first resource error, if any. */
  private _computeError(): string | null
  {
    return this._serversResource.error()?.message ?? this._groupsResource.error()?.message ?? null;
  }

  /** Build the MCP inventory subtitle shown in the section header. */
  private _computeServersSubtitle(): string
  {
    return `${this._servers().length} registered • ${this._activeCount()} active • ${this._degradedCount()} degraded • ${this._draftCount()} draft`;
  }

  /** Count servers in the active state. */
  private _computeActiveCount(): number
  {
    return this._servers().filter(function _isActive(server)
    {
      return server.status === McpServerStatus.Active;
    }).length;
  }

  /** Count servers in the degraded state. */
  private _computeDegradedCount(): number
  {
    return this._servers().filter(function _isDegraded(server)
    {
      return server.status === McpServerStatus.Degraded;
    }).length;
  }

  /** Count servers in the draft state. */
  private _computeDraftCount(): number
  {
    return this._servers().filter(function _isDraft(server)
    {
      return server.status === McpServerStatus.Draft;
    }).length;
  }

  /** Select a server for the grant preview section. */
  _selectServer(serverId: string): void
  {
    this._catalogState.selectItem(serverId);
  }

  /** Persist a local preview of the selected server grants. */
  _updateSelectedGrants(grants: McpServer["grants"]): void
  {
    this._catalogState.updateSelectedGrants(grants);
  }

  /** Reload both MCP and group inventories. */
  _reload(): void
  {
    this._serversResource.reload();
    this._groupsResource.reload();
  }

  /** Map a group scope to a PrimeNG tag severity. */
  _scopeSeverity(scope: Group["scope"]): "info" | "warn" | "success" | "secondary"
  {
    return getGrantScopeSeverity(scope);
  }
}
