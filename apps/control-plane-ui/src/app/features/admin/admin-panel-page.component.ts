import { Component, inject, OnInit, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { RouterModule } from "@angular/router";
import { ButtonModule } from "primeng/button";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";
import { ProgressSpinnerModule } from "primeng/progressspinner";
import { MessageModule } from "primeng/message";
import { InputTextModule } from "primeng/inputtext";

import { TenantApiService } from "../../core/api/tenants.service";
import type { TenantSummary } from "../../core/models/tenant.models";

/**
 * Admin Panel feature page — lists all tenants in a sortable, filterable table
 * with phase badges and direct action links for operators.
 */
@Component({
  selector: "oc-admin",
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    TableModule,
    TagModule,
    ProgressSpinnerModule,
    MessageModule,
    InputTextModule,
  ],
  template: `
    <div class="p-4">
      <div class="flex justify-content-between align-items-center mb-4">
        <h1 class="text-2xl font-bold m-0">Admin Panel</h1>
        <div class="flex gap-2 align-items-center">
          <input
            pInputText
            [(ngModel)]="_filter"
            placeholder="Filter by name or team..."
            class="p-inputtext-sm"
          />
          <a routerLink="/provision">
            <p-button label="New Tenant" icon="pi pi-plus" size="small" />
          </a>
        </div>
      </div>

      @if (_loading()) {
        <p-progressSpinner />
      } @else if (_error()) {
        <p-message severity="error" [text]="_error()!" />
      } @else {
        <p-table
          [value]="_filteredTenants()"
          [sortField]="'name'"
          [sortOrder]="1"
          [paginator]="true"
          [rows]="25"
          [showCurrentPageReport]="true"
          currentPageReportTemplate="Showing {first} to {last} of {totalRecords} tenants"
          styleClass="p-datatable-sm"
        >
          <ng-template pTemplate="header">
            <tr>
              <th pSortableColumn="name">Name <p-sortIcon field="name" /></th>
              <th pSortableColumn="displayName">Display Name <p-sortIcon field="displayName" /></th>
              <th pSortableColumn="team">Team <p-sortIcon field="team" /></th>
              <th pSortableColumn="phase">Phase <p-sortIcon field="phase" /></th>
              <th>Actions</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-tenant>
            <tr>
              <td><code class="text-sm">{{ tenant.name }}</code></td>
              <td>{{ tenant.displayName }}</td>
              <td>{{ tenant.team ?? "—" }}</td>
              <td>
                <p-tag
                  [value]="tenant.phase"
                  [severity]="_phaseSeverity(tenant.phase)"
                />
              </td>
              <td>
                <a [routerLink]="['/tenants', tenant.name]">
                  <p-button
                    icon="pi pi-eye"
                    [text]="true"
                    size="small"
                    pTooltip="View detail"
                  />
                </a>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr>
              <td colspan="5" class="text-center text-color-secondary">No tenants match the filter.</td>
            </tr>
          </ng-template>
        </p-table>
        <p class="text-color-secondary text-sm mt-2">
          {{ _tenants().length }} total —
          {{ _runningCount() }} running,
          {{ _suspendedCount() }} suspended,
          {{ _errorCount() }} error
        </p>
      }
    </div>
  `,
})
export class AdminPanelPageComponent implements OnInit
{
  /** Injected tenant API service. */
  private readonly _tenantApi = inject(TenantApiService);

  /** Full unfiltered tenant list. */
  readonly _tenants = signal<TenantSummary[]>([]);

  /** Current filter string for table filtering. */
  _filter = "";

  /** Page loading state. */
  readonly _loading = signal(true);

  /** Error message. */
  readonly _error = signal<string | null>(null);

  /**
   * Load all tenants from the API on component initialisation.
   */
  async ngOnInit(): Promise<void>
  {
    try
    {
      // 1. Load the full tenant list — the admin panel does not paginate server-side.
      const tenants = await this._tenantApi.listTenants();
      this._tenants.set(tenants);
    }
    catch (err)
    {
      // 2. Display the error instead of crashing the panel.
      this._error.set(err instanceof Error ? err.message : "Failed to load tenants");
    }
    finally
    {
      // 3. Always clear the loading state.
      this._loading.set(false);
    }
  }

  /**
   * Return tenants filtered by the current filter string.
   * Matches against name, displayName, team, and email fields.
   */
  _filteredTenants(): TenantSummary[]
  {
    const query = this._filter.trim().toLowerCase();
    if (!query)
    {
      return this._tenants();
    }

    return this._tenants().filter(function _matches(t)
    {
      return t.name.toLowerCase().includes(query)
        || t.displayName.toLowerCase().includes(query)
        || (t.team ?? "").toLowerCase().includes(query)
        || t.email.toLowerCase().includes(query);
    });
  }

  /**
   * Map a lifecycle phase string to a PrimeNG Tag severity.
   * @param phase - Tenant lifecycle phase string.
   */
  _phaseSeverity(phase: string): "success" | "info" | "warn" | "danger" | "secondary"
  {
    const map: Record<string, "success" | "info" | "warn" | "danger" | "secondary"> = {
      Running: "success",
      Pending: "info",
      Suspended: "warn",
      Error: "danger",
    };

    return map[phase] ?? "secondary";
  }

  /** Count tenants in the Running phase. */
  _runningCount(): number
  {
    return this._tenants().filter(function _isRunning(t) { return t.phase === "Running"; }).length;
  }

  /** Count tenants in the Suspended phase. */
  _suspendedCount(): number
  {
    return this._tenants().filter(function _isSuspended(t) { return t.phase === "Suspended"; }).length;
  }

  /** Count tenants in the Error phase. */
  _errorCount(): number
  {
    return this._tenants().filter(function _isError(t) { return t.phase === "Error"; }).length;
  }
}
