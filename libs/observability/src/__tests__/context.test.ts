import { describe, expect, it } from "vitest";

import { ___ContextMixin, ___GetContext, ___RunWithContext, ___SetContextField } from "../context.js";

describe("context", function _contextSuite()
{
  it("returns undefined / empty outside any scope", function _outside()
  {
    expect(___GetContext()).toBeUndefined();
    expect(___ContextMixin()).toEqual({});
  });

  it("exposes requestId and extra fields inside a scope", function _inside()
  {
    ___RunWithContext({ requestId: "req-1", extra: { tenant: "acme" } }, function _run()
    {
      expect(___GetContext()?.requestId).toBe("req-1");
      expect(___ContextMixin()).toEqual({ requestId: "req-1", tenant: "acme" });
    });
  });

  it("merges fields added with ___SetContextField", function _setField()
  {
    ___RunWithContext({ requestId: "req-2", extra: {} }, function _run()
    {
      ___SetContextField("operation", "tenant.reconcile");
      expect(___ContextMixin()).toEqual({ requestId: "req-2", operation: "tenant.reconcile" });
    });
  });

  it("isolates concurrent async scopes with no field bleed", async function _concurrent()
  {
    async function _task(id: string, delayMs: number): Promise<string>
    {
      return ___RunWithContext({ requestId: id, extra: {} }, async function _run()
      {
        await new Promise(function _wait(resolve) { setTimeout(resolve, delayMs); });
        // After awaiting, the context must still be this task's, not the other's.
        return ___GetContext()?.requestId ?? "none";
      });
    }

    const [a, b] = await Promise.all([_task("A", 20), _task("B", 5)]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(___GetContext()).toBeUndefined();
  });
});
