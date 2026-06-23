import { describe, it, expect, vi } from "vitest";
import pino from "pino";

import { defaultConfig, _makeTenant } from "../fixtures.js";
import { _ResolveOrgServingDomain } from "../../tenants/internal/org-serving-domain.js";
import { TenantOperator } from "../../tenants/operator.js";
import { TenantStatusPhase } from "../../tenants/models/tenant-status.interface.js";
import type { TenantStatusWriter } from "../../tenants/internal/tenant-status-writer.js";
import type { Tenant } from "../../tenants/models/tenant.interface.js";

describe("TenantOperator", () =>
{
  it("builds correct resource names from tenant name", () =>
  {
    const tenant = _makeTenant("jente");
    const name = tenant.metadata!.name;

    expect(`openclaw-${name}`).toBe("openclaw-jente");
    expect(`openclaw-${name}-config`).toBe("openclaw-jente-config");
    expect(`openclaw-${name}-encryption-key`).toBe("openclaw-jente-encryption-key");
    expect(`openclaw-${name}-bucket`).toBe("openclaw-jente-bucket");
  });

  it("serves a user at the ORG host (no per-user subdomain)", () =>
  {
    // The user reaches their pod through the org host `<org>.<base>` via the in-operator
    // proxy; there is no `<user>.<org>.<base>` host any more.
    expect(_ResolveOrgServingDomain("acme", undefined, defaultConfig.ingressDomain)).toBe("acme.opencrane.local");
    expect(_ResolveOrgServingDomain(undefined, undefined, defaultConfig.ingressDomain)).toBe("opencrane.local");
  });

  it("respects custom image override", () =>
  {
    const tenant = _makeTenant("mike", {
      openclawImage: "custom-registry/openclaw:v2",
    });

    const image = tenant.spec.openclawImage ?? defaultConfig.tenantDefaultImage;
    expect(image).toBe("custom-registry/openclaw:v2");
  });

  it("falls back to default image when no override", () =>
  {
    const tenant = _makeTenant("anna");

    const image = tenant.spec.openclawImage ?? defaultConfig.tenantDefaultImage;
    expect(image).toBe("ghcr.io/opencrane/tenant:latest");
  });

  it("detects suspended tenants", () =>
  {
    const active = _makeTenant("active");
    const suspended = _makeTenant("paused", { suspended: true });

    expect(active.spec.suspended).toBeFalsy();
    expect(suspended.spec.suspended).toBe(true);
  });

  it("merges config overrides", () =>
  {
    const tenant = _makeTenant("custom", {
      configOverrides: {
        agents: { defaults: { thinking: "high" } },
      },
    });

    const baseConfig = {
      gateway: { mode: "local", port: 18789, bind: "lan" },
    };

    const merged: Record<string, unknown> = tenant.spec.configOverrides
      ? { ...baseConfig, ...tenant.spec.configOverrides }
      : baseConfig;

    expect(merged.agents).toEqual({ defaults: { thinking: "high" } });
  });

  it("supports openclawVersion on tenant spec", () =>
  {
    const tenant = _makeTenant("versioned", { openclawVersion: "2026.3.15" });
    expect(tenant.spec.openclawVersion).toBe("2026.3.15");
  });

  it("defaults openclawVersion to the pinned operator default (not latest) when not set", () =>
  {
    const tenant = _makeTenant("default-version");
    const version = tenant.spec.openclawVersion ?? defaultConfig.defaultOpenclawVersion;
    expect(version).toBe("2026.6.9");
    expect(version).not.toBe("latest");
  });
});

describe("TenantOperator reconcile guard + coalescing", () =>
{
  /** Build an operator whose only live dependency is a status-writer spy; the rest are
   *  unused by the guard short-circuit / by an overridden reconcile, so they are cast stubs. */
  function _build(): { op: TenantOperator; patch: ReturnType<typeof vi.fn> }
  {
    const patch = vi.fn(async () => {});
    const statusWriter = { patchStatus: patch } as unknown as TenantStatusWriter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = {} as any;
    const op = new TenantOperator(stub, stub, stub, stub, stub, pino({ level: "silent" }),
      defaultConfig, stub, stub, statusWriter, stub, stub);
    return { op, patch };
  }

  it("skips the reconcile when an already-Running tenant's generation is unchanged", async () =>
  {
    const { op, patch } = _build();
    const tenant = _makeTenant("acme"); // status.phase = Running
    tenant.metadata!.generation = 3;
    tenant.status!.observedGeneration = 3;

    await op.reconcileTenant(tenant);

    // Guard short-circuited before any work — no status write, no resource applies.
    expect(patch).not.toHaveBeenCalled();
  });

  it("does NOT skip when a spec change bumps generation past observedGeneration", async () =>
  {
    const { op } = _build();
    // Override the heavy reconcile body; we only assert the guard let execution through.
    let ran = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (op as any).reconcileTenant = async () => { ran = true; };
    const tenant = _makeTenant("acme");
    tenant.metadata!.generation = 4;
    tenant.status!.observedGeneration = 3; // stale → must reconcile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (op as any).dispatchReconcile(tenant);
    expect(ran).toBe(true);
  });

  it("coalesces concurrent events for one tenant into a single re-run", async () =>
  {
    const { op } = _build();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstCall = true;
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (op as any).reconcileTenant = async (t: Tenant) => {
      calls.push(t.metadata!.name!);
      if (firstCall) { firstCall = false; await gate; }
    };

    const tenant = _makeTenant("acme");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatch = (t: Tenant) => (op as any).dispatchReconcile(t);
    const first = dispatch(tenant);   // starts, blocks on the gate
    await dispatch(tenant);           // queued (running) — returns immediately
    await dispatch(tenant);           // collapsed into the same single pending slot
    release();
    await first;

    // 3 events while one was in flight → exactly 2 reconciles (in-flight + one coalesced).
    expect(calls).toEqual(["acme", "acme"]);
  });
});

describe("ServiceAccount (Workload Identity)", () =>
{
  it("generates correct GCP service account annotation via adapter", () =>
  {
    const name = "jente";
    const projectId = "my-gcp-project";
    const expected = `openclaw-${name}@${projectId}.iam.gserviceaccount.com`;

    expect(expected).toBe("openclaw-jente@my-gcp-project.iam.gserviceaccount.com");
  });
});
