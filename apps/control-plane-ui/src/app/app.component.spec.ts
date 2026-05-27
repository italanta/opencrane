import { TestBed } from "@angular/core/testing";

import { AppComponent } from "./app.component";

describe("AppComponent", function _describeAppComponent()
{
  it("creates the root component", async function _createsRootComponent()
  {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    expect(app).toBeTruthy();
  });

  it("provides the expected navigation entries", async function _providesNavigationEntries()
  {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as AppComponent;
    const navigation = (app as any).navigation as Array<{ label: string }>;

    expect(navigation.length).toBe(8);
    expect(navigation.map(function _pluckLabel(item)
    {
      return item.label;
    })).toEqual([
      "Dashboard",
      "MCP Servers",
      "Skill Catalog",
      "Schedules",
      "Server Metrics",
      "Token Usage & Budgets",
      "Access Tokens",
      "Provider Keys",
    ]);
  });
});
