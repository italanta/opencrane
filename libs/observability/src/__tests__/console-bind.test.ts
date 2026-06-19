import { Writable } from "node:stream";

import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";

import { ___BindConsole } from "../console-bind.js";
import { ___ContextMixin, ___RunWithContext } from "../context.js";

/** Build a pino logger that records each emitted record into an array. */
function _memLogger(): { logger: Logger; records: Array<Record<string, unknown>> }
{
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void
    {
      records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const logger = pino({ level: "debug", mixin: ___ContextMixin }, stream);
  return { logger, records };
}

describe("___BindConsole", function _bindConsoleSuite()
{
  it("forwards console.log to one structured info record", function _single()
  {
    const { logger, records } = _memLogger();
    const unbind = ___BindConsole(logger);
    try
    {
      console.log("hello %s", "world");
    }
    finally
    {
      unbind();
    }
    // Exactly one record => no recursion through the patched console.
    expect(records).toHaveLength(1);
    expect(records[0]?.["level"]).toBe(30);
    expect(records[0]?.["msg"]).toBe("hello world");
  });

  it("maps console.warn/error/debug to the right levels", function _levels()
  {
    const { logger, records } = _memLogger();
    const unbind = ___BindConsole(logger);
    try
    {
      console.warn("w");
      console.error("e");
      console.debug("d");
    }
    finally
    {
      unbind();
    }
    expect(records.map(function _lvl(r) { return r["level"]; })).toEqual([40, 50, 20]);
  });

  it("serialises an Error-first call under err", function _errorFirst()
  {
    const { logger, records } = _memLogger();
    const unbind = ___BindConsole(logger);
    try
    {
      console.error(new Error("boom"));
    }
    finally
    {
      unbind();
    }
    expect(records[0]?.["msg"]).toBe("boom");
    expect((records[0]?.["err"] as { type?: string })?.type).toBe("Error");
  });

  it("keeps an object-first call's fields structured", function _objectFirst()
  {
    const { logger, records } = _memLogger();
    const unbind = ___BindConsole(logger);
    try
    {
      console.warn({ tenant: "acme", failures: 2 }, "sync partial");
    }
    finally
    {
      unbind();
    }
    expect(records[0]?.["tenant"]).toBe("acme");
    expect(records[0]?.["failures"]).toBe(2);
    expect(records[0]?.["msg"]).toBe("sync partial");
  });

  it("inherits request context on forwarded console calls", function _withContext()
  {
    const { logger, records } = _memLogger();
    const unbind = ___BindConsole(logger);
    try
    {
      ___RunWithContext({ requestId: "req-9", extra: {} }, function _run() { console.log("scoped"); });
    }
    finally
    {
      unbind();
    }
    expect(records[0]?.["requestId"]).toBe("req-9");
  });

  it("restores the original console methods on unbind", function _restore()
  {
    const original = console.log;
    const { logger } = _memLogger();
    const unbind = ___BindConsole(logger);
    expect(console.log).not.toBe(original);
    unbind();
    expect(console.log).toBe(original);
  });
});
