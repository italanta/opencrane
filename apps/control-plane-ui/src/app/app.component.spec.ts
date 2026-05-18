import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";

import { AuthService } from "./core/auth/auth.service";
import { AppComponent } from "./app.component";

class _AuthServiceMock
{
  readonly status = signal({
    mode: "oidc",
    authenticated: true,
    user: { sub: "spec-user", issuer: "spec", authenticatedAt: new Date().toISOString() },
  }).asReadonly();

  async ensureLoaded(): Promise<void>
  {
    return;
  }

  async logout(): Promise<void>
  {
    return;
  }
}

describe("AppComponent", function _describeAppComponent()
{
  it("creates the root component", async function _createsRootComponent()
  {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: AuthService, useValue: new _AuthServiceMock() }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    expect(app).toBeTruthy();
  });

  it("provides the expected navigation entries", async function _providesNavigationEntries()
  {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: AuthService, useValue: new _AuthServiceMock() }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as AppComponent;

    expect((app as any).navigation.length).toBe(5);
  });
});
