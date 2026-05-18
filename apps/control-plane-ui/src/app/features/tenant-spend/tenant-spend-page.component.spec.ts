import { TestBed } from "@angular/core/testing";

import { ControlPlaneApiService } from "../../core/api/control-plane-api.service";
import type { TenantSpendSummary } from "../../core/models/tenant-spend.types";
import { TenantSpendPageComponent } from "./tenant-spend-page.component";

class _ControlPlaneApiServiceMock
{
  async getTenantSpend(_tenantName: string): Promise<TenantSpendSummary>
  {
    return {
      tenantName: "demo",
      totalCostUsd: 25,
      monthlyBudgetUsd: 100,
      remainingBudgetUsd: 75,
      topModels: [{ model: "gpt-4.1", costUsd: 20, requests: 10 }],
    };
  }
}

describe("TenantSpendPageComponent", function _describeTenantSpendPageComponent()
{
  async function _createFixture(api: ControlPlaneApiService): Promise<ReturnType<typeof TestBed.createComponent<TenantSpendPageComponent>>>
  {
    await TestBed.configureTestingModule({
      imports: [TenantSpendPageComponent],
      providers: [{ provide: ControlPlaneApiService, useValue: api }],
    }).compileComponents();

    return TestBed.createComponent(TenantSpendPageComponent);
  }

  it("loads tenant spend and exposes budget summary text", async function _loadsTenantSpendAndExposesBudgetSummaryText()
  {
    const api = new _ControlPlaneApiServiceMock();
    const fixture = await _createFixture(api as unknown as ControlPlaneApiService);
    const component = fixture.componentInstance as TenantSpendPageComponent;

    (component as any).tenantForm.controls.tenantName.setValue("demo");
    await (component as any).loadSpend();

    expect((component as any).summary()?.tenantName).toBe("demo");
    expect((component as any).budgetStatement()).toBe("You have $75.00 of $100.00 budget remaining.");
    expect((component as any).utilizationPercent()).toBe(25);
  });

  it("surfaces API errors with a user-facing message", async function _surfacesApiErrorsWithUserFacingMessage()
  {
    const api = {
      async getTenantSpend(_tenantName: string): Promise<TenantSpendSummary>
      {
        throw new Error("boom");
      },
    };

    const fixture = await _createFixture(api as unknown as ControlPlaneApiService);
    const component = fixture.componentInstance as TenantSpendPageComponent;

    (component as any).tenantForm.controls.tenantName.setValue("demo");
    await (component as any).loadSpend();

    expect((component as any).summary()).toBeNull();
    expect((component as any).error()).toContain("Unable to load tenant spend");
  });

  it("rejects whitespace-only tenant names before API calls", async function _rejectsWhitespaceOnlyTenantNamesBeforeApiCalls()
  {
    const api = {
      async getTenantSpend(_tenantName: string): Promise<TenantSpendSummary>
      {
        throw new Error("should not be called");
      },
    };

    const fixture = await _createFixture(api as unknown as ControlPlaneApiService);
    const component = fixture.componentInstance as TenantSpendPageComponent;

    (component as any).tenantForm.controls.tenantName.setValue("   ");
    await (component as any).loadSpend();

    expect((component as any).summary()).toBeNull();
    expect((component as any).error()).toBe("Tenant name is required.");
  });
});