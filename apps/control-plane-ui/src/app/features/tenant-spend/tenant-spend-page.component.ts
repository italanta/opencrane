import { CommonModule } from "@angular/common";
import { Component, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from "@angular/forms";
import { ButtonModule } from "primeng/button";
import { InputTextModule } from "primeng/inputtext";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";

import { ControlPlaneApiService } from "../../core/api/control-plane-api.service";
import type { TenantSpendSummary } from "../../core/models/tenant-spend.types";
import { UiKpiTileComponent } from "../../shared/components/ui-kpi-tile/ui-kpi-tile.component";
import { UiSectionCardComponent } from "../../shared/components/ui-section-card/ui-section-card.component";

/** Displays per-tenant spend and budget status using the control-plane spend endpoint. */
@Component({
  selector: "oc-tenant-spend-page",
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, ButtonModule, InputTextModule, TableModule, TagModule, UiKpiTileComponent, UiSectionCardComponent],
  templateUrl: "./tenant-spend-page.component.html",
  styleUrl: "./tenant-spend-page.component.css",
})
export class TenantSpendPageComponent
{
  /** Form for selecting which tenant spend summary to inspect. */
  protected readonly tenantForm = new FormGroup({
    tenantName: new FormControl<string>("", { nonNullable: true, validators: [Validators.required] }),
  });

  /** Latest spend summary from the API for the selected tenant. */
  protected readonly summary = signal<TenantSpendSummary | null>(null);

  /** Controls loading state for in-flight spend lookups. */
  protected readonly loading = signal<boolean>(false);

  /** User-facing error message for failed spend lookups. */
  protected readonly error = signal<string>("");

  constructor(private readonly api: ControlPlaneApiService)
  {
  }

  /** Resolve spend and budget details for the selected tenant. */
  protected async loadSpend(): Promise<void>
  {
    if (this.tenantForm.invalid)
    {
      return;
    }

    const tenantName = this.tenantForm.controls.tenantName.getRawValue().trim();
    if (!tenantName)
    {
      this.error.set("Tenant name is required.");
      this.summary.set(null);
      return;
    }

    // 1. Reset stale state so a new lookup does not show outdated summary/error data.
    this.loading.set(true);
    this.error.set("");
    this.summary.set(null);

    try
    {
      // 2. Call the spend API with the normalized tenant name to fetch fresh budget state.
      const payload = await this.api.getTenantSpend(tenantName);

      // 3. Persist the payload for KPI cards and model breakdown rendering.
      this.summary.set(payload);
    }
    catch
    {
      this.error.set("Unable to load tenant spend. Verify tenant name and control-plane connectivity.");
    }
    finally
    {
      this.loading.set(false);
    }
  }

  /** Render a compact budget statement for dashboards and screenshots. */
  protected budgetStatement(): string
  {
    const current = this.summary();
    if (!current || current.monthlyBudgetUsd === null || current.remainingBudgetUsd === null)
    {
      return "No monthly budget configured for this tenant.";
    }

    return `You have $${current.remainingBudgetUsd.toFixed(2)} of $${current.monthlyBudgetUsd.toFixed(2)} budget remaining.`;
  }

  /** Returns spend utilization percentage for progress tags. */
  protected utilizationPercent(): number
  {
    const current = this.summary();
    if (!current || current.monthlyBudgetUsd === null || current.monthlyBudgetUsd <= 0)
    {
      return 0;
    }

    const usedPercent = (current.totalCostUsd / current.monthlyBudgetUsd) * 100;
    return Math.min(100, Math.max(0, usedPercent));
  }
}