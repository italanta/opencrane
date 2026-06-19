import { describe, expect, it } from "vitest";

import { ___GetContext } from "../context.js";
import { ___RequestContext } from "../express.js";

/** Minimal response double capturing headers set by the middleware. */
function _fakeRes(): { headers: Record<string, string>; setHeader(name: string, value: string): void }
{
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string): void { headers[name] = value; },
  };
}

describe("___RequestContext", function _requestContextSuite()
{
  it("mints a requestId, echoes it, and exposes it to handlers", function _mint()
  {
    const mw = ___RequestContext();
    const res = _fakeRes();
    let seenId: string | undefined;

    mw({ headers: {}, method: "GET", path: "/healthz" }, res, function _next()
    {
      seenId = ___GetContext()?.requestId;
    });

    expect(seenId).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(seenId);
  });

  it("reuses an inbound x-request-id", function _reuse()
  {
    const mw = ___RequestContext();
    const res = _fakeRes();
    let seenId: string | undefined;

    mw({ headers: { "x-request-id": "upstream-7" }, method: "POST", path: "/api/v1/tenants" }, res, function _next()
    {
      seenId = ___GetContext()?.requestId;
    });

    expect(seenId).toBe("upstream-7");
    expect(res.headers["x-request-id"]).toBe("upstream-7");
  });

  it("surfaces method and path as context fields", function _fields()
  {
    const mw = ___RequestContext();
    let extra: Record<string, unknown> | undefined;

    mw({ headers: {}, method: "DELETE", path: "/api/v1/tenants/acme" }, _fakeRes(), function _next()
    {
      extra = ___GetContext()?.extra;
    });

    expect(extra).toEqual({ method: "DELETE", path: "/api/v1/tenants/acme" });
  });
});
