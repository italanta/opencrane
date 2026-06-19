import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { REDACT_PATHS } from "../redact.js";

/** Build a pino logger applying REDACT_PATHS, capturing records into an array. */
function _redactingLogger(): { logger: pino.Logger; records: Array<Record<string, unknown>> }
{
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void
    {
      records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const logger = pino({ redact: [...REDACT_PATHS] }, stream);
  return { logger, records };
}

describe("REDACT_PATHS", function _redactSuite()
{
  it("redacts top-level credential fields from logged objects", function _topLevel()
  {
    const { logger, records } = _redactingLogger();
    logger.info({ masterKey: "sk-secret", token: "t-123", password: "hunter2" }, "config");
    expect(records[0]?.["masterKey"]).toBe("[Redacted]");
    expect(records[0]?.["token"]).toBe("[Redacted]");
    expect(records[0]?.["password"]).toBe("[Redacted]");
  });

  it("redacts nested credential fields via wildcard paths", function _nested()
  {
    const { logger, records } = _redactingLogger();
    logger.info({ litellm: { apiKey: "sk-nested", masterKey: "mk-nested" } }, "nested");
    const litellm = records[0]?.["litellm"] as Record<string, unknown>;
    expect(litellm["apiKey"]).toBe("[Redacted]");
    expect(litellm["masterKey"]).toBe("[Redacted]");
  });

  it("redacts the Authorization request header", function _authHeader()
  {
    const { logger, records } = _redactingLogger();
    logger.info({ req: { headers: { authorization: "Bearer leak-me" } } }, "request");
    const req = records[0]?.["req"] as { headers: Record<string, unknown> };
    expect(req.headers["authorization"]).toBe("[Redacted]");
  });

  it("leaves non-sensitive fields intact", function _passthrough()
  {
    const { logger, records } = _redactingLogger();
    logger.info({ tenant: "acme", requestId: "req-1" }, "ok");
    expect(records[0]?.["tenant"]).toBe("acme");
    expect(records[0]?.["requestId"]).toBe("req-1");
  });
});
