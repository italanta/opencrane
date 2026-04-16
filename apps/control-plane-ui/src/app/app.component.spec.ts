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

    expect((app as any).navigation.length).toBe(4);
  });
});
