import { afterEach, describe, expect, it, vi } from "vitest";

import { _ResolveTarget } from "../auth-client.js";

/** Build a minimal Response-like for the stubbed fetch. */
function _res(status: number, body?: unknown): Response
{
  return {
    status,
    json: async () => { if (body === undefined) throw new Error("no body"); return body; },
  } as unknown as Response;
}

const validBody = {
  user: { email: "alice@example.com", sub: "sub-1" },
  tenant: { name: "alice", clusterTenantRef: "acme" },
  podService: { name: "openclaw-alice", namespace: "opencrane-acme" },
};

describe("_ResolveTarget (delegated auth)", () =>
{
  afterEach(() => vi.unstubAllGlobals());

  it("returns the forward target on a clean 200", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue(_res(200, validBody));
    vi.stubGlobal("fetch", fetchSpy);

    const out = await _ResolveTarget("http://cp:8080/", "sid=abc", new AbortController().signal);

    expect(out).toEqual({ ok: true, target: validBody });
    // Calls the resolve path and replays ONLY the cookie header.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://cp:8080/api/v1/auth/gateway-resolve");
    expect(init.headers).toEqual({ cookie: "sid=abc" });
    expect(init.redirect).toBe("error");
  });

  it("sends no cookie header when the upgrade carried none", async () =>
  {
    const fetchSpy = vi.fn().mockResolvedValue(_res(200, validBody));
    vi.stubGlobal("fetch", fetchSpy);

    await _ResolveTarget("http://cp:8080", undefined, new AbortController().signal);

    expect(fetchSpy.mock.calls[0][1].headers).toEqual({});
  });

  it("propagates 401 and 403 fail-closed", async () =>
  {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(_res(401)));
    expect(await _ResolveTarget("http://cp", "c", new AbortController().signal)).toMatchObject({ ok: false, status: 401 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(_res(403)));
    expect(await _ResolveTarget("http://cp", "c", new AbortController().signal)).toMatchObject({ ok: false, status: 403 });
  });

  it("maps any other status to a 502 fail-closed (never guesses a route)", async () =>
  {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(_res(500)));
    expect(await _ResolveTarget("http://cp", "c", new AbortController().signal)).toMatchObject({ ok: false, status: 502 });
  });

  it("maps a network error to 502", async () =>
  {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await _ResolveTarget("http://cp", "c", new AbortController().signal)).toMatchObject({ ok: false, status: 502 });
  });

  it("rejects an incomplete body as 502", async () =>
  {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(_res(200, { user: { email: "a", sub: "s" }, tenant: { name: "t" } })));
    expect(await _ResolveTarget("http://cp", "c", new AbortController().signal)).toMatchObject({ ok: false, status: 502 });
  });
});
