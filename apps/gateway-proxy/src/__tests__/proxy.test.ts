import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { _HandleUpgrade } from "../proxy.js";
import type { UpgradeDeps, WsProxy } from "../proxy.js";
import type { ResolveOutcome } from "../auth-client.js";
import { FixedWindowRateLimiter } from "../rate-limit.js";
import type { GatewayProxyConfig } from "../config.js";
import type { Logger } from "@opencrane/observability";

/** A logger whose every method (and .child) is a no-op, for silent tests. */
function _silentLog(): Logger
{
  const noop = () => undefined;
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log } as unknown as Logger;
  return log;
}

/** A fake upgrade socket recording what was written and whether it was destroyed. */
function _fakeSocket(): Duplex & { written: string[]; destroyed: boolean }
{
  const written: string[] = [];
  const socket = {
    written,
    destroyed: false,
    write(chunk: string) { written.push(chunk); return true; },
    destroy() { (socket as { destroyed: boolean }).destroyed = true; },
  };
  return socket as unknown as Duplex & { written: string[]; destroyed: boolean };
}

/** A fake WS proxy recording forward targets. */
function _fakeProxy(): WsProxy & { targets: string[] }
{
  const targets: string[] = [];
  return {
    targets,
    ws(_req, _socket, _head, options) { targets.push(options.target); },
  };
}

const baseConfig: GatewayProxyConfig = {
  port: 8090,
  controlPlaneUrl: "http://cp:8080",
  gatewayPort: 8080,
  clusterDomain: "svc.cluster.local",
  allowedOrigins: ["https://acme.opencrane.ai"],
  rateLimitPerMinute: 60,
};

const okTarget: ResolveOutcome = {
  ok: true,
  target: {
    user: { email: "alice@example.com", sub: "sub-1" },
    tenant: { name: "alice", clusterTenantRef: "acme" },
    podService: { name: "openclaw-alice", namespace: "opencrane-acme" },
  },
};

/** Build deps with an injected resolver and overridable config. */
function _deps(resolve: UpgradeDeps["resolve"], overrides: Partial<GatewayProxyConfig> = {}): { deps: UpgradeDeps; proxy: WsProxy & { targets: string[] } }
{
  const proxy = _fakeProxy();
  const deps: UpgradeDeps = {
    config: { ...baseConfig, ...overrides },
    proxy,
    limiter: new FixedWindowRateLimiter(overrides.rateLimitPerMinute ?? 60, () => 1_000),
    log: _silentLog(),
    resolve,
  };
  return { deps, proxy };
}

/** Build a fake upgrade request with the given headers. */
function _req(headers: Record<string, string | undefined>): IncomingMessage
{
  return { headers, url: "/", socket: { remoteAddress: "10.0.0.1" } } as unknown as IncomingMessage;
}

describe("_HandleUpgrade", () =>
{
  it("authorises and proxies a valid upgrade to the resolved pod Service", async () =>
  {
    const resolve = vi.fn().mockResolvedValue(okTarget);
    const { deps, proxy } = _deps(resolve);
    const socket = _fakeSocket();

    await _HandleUpgrade(deps, _req({ origin: "https://acme.opencrane.ai", cookie: "sid=x" }), socket, Buffer.alloc(0));

    expect(proxy.targets).toEqual(["ws://openclaw-alice.opencrane-acme.svc.cluster.local:8080"]);
    expect(socket.destroyed).toBe(false);
    // Cookie was forwarded to the resolver; no route decided locally.
    expect(resolve).toHaveBeenCalledWith("http://cp:8080", "sid=x", expect.any(AbortSignal));
  });

  it("refuses (403) and never calls the control plane on a non-allowlisted origin (CSWSH)", async () =>
  {
    const resolve = vi.fn().mockResolvedValue(okTarget);
    const { deps, proxy } = _deps(resolve);
    const socket = _fakeSocket();

    await _HandleUpgrade(deps, _req({ origin: "https://evil.example.com", cookie: "sid=x" }), socket, Buffer.alloc(0));

    expect(resolve).not.toHaveBeenCalled();
    expect(proxy.targets).toEqual([]);
    expect(socket.destroyed).toBe(true);
    expect(socket.written[0]).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });

  it("refuses a missing origin (fail closed)", async () =>
  {
    const resolve = vi.fn().mockResolvedValue(okTarget);
    const { deps, proxy } = _deps(resolve);
    const socket = _fakeSocket();

    await _HandleUpgrade(deps, _req({ cookie: "sid=x" }), socket, Buffer.alloc(0));

    expect(resolve).not.toHaveBeenCalled();
    expect(proxy.targets).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("propagates the control-plane refusal status and closes the socket", async () =>
  {
    const resolve = vi.fn().mockResolvedValue({ ok: false, status: 403, reason: "forbidden" } as ResolveOutcome);
    const { deps, proxy } = _deps(resolve);
    const socket = _fakeSocket();

    await _HandleUpgrade(deps, _req({ origin: "https://acme.opencrane.ai", cookie: "sid=x" }), socket, Buffer.alloc(0));

    expect(proxy.targets).toEqual([]);
    expect(socket.written[0]).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(socket.destroyed).toBe(true);
  });

  it("refuses (429) once an identity exceeds its per-minute budget", async () =>
  {
    const resolve = vi.fn().mockResolvedValue(okTarget);
    const { deps, proxy } = _deps(resolve, { rateLimitPerMinute: 1 });
    const first = _fakeSocket();
    const second = _fakeSocket();

    await _HandleUpgrade(deps, _req({ origin: "https://acme.opencrane.ai", cookie: "sid=x" }), first, Buffer.alloc(0));
    await _HandleUpgrade(deps, _req({ origin: "https://acme.opencrane.ai", cookie: "sid=x" }), second, Buffer.alloc(0));

    expect(proxy.targets).toHaveLength(1); // only the first got through
    expect(second.written[0]).toMatch(/^HTTP\/1\.1 429 Too Many Requests/);
    expect(second.destroyed).toBe(true);
  });
});
