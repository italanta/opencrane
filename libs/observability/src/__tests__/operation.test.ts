import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ___GetContext } from "../context.js";
import { ___DoWithTrace } from "../operation.js";

/** Captures spans emitted by ___DoWithTrace for assertion. */
const _exporter = new InMemorySpanExporter();

beforeAll(function _registerProvider()
{
  // Register an in-memory tracer so trace.getTracer in operation.ts produces
  // real spans we can inspect, without a live collector.
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(_exporter)] });
  provider.register();
});

afterAll(async function _shutdown()
{
  await _exporter.shutdown();
});

describe("___DoWithTrace", function _withOperationSuite()
{
  it("seeds context, sets duration, and ends an OK span on success", async function _success()
  {
    _exporter.reset();
    const seen = await ___DoWithTrace("tenant.reconcile", { tenant: "acme" }, async function _work()
    {
      return ___GetContext();
    });

    expect(seen?.extra["operation"]).toBe("tenant.reconcile");
    expect(seen?.extra["tenant"]).toBe("acme");
    expect(typeof seen?.requestId).toBe("string");

    const spans = _exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("tenant.reconcile");
    expect(spans[0]?.status.code).toBe(SpanStatusCode.OK);
    expect(spans[0]?.attributes["tenant"]).toBe("acme");
    expect(typeof spans[0]?.attributes["duration_ms"]).toBe("number");
  });

  it("records the exception and re-throws on failure", async function _failure()
  {
    _exporter.reset();
    await expect(
      ___DoWithTrace("oci.bundle.push", { digest: "sha256:bad" }, async function _work()
      {
        throw new Error("registry unreachable");
      }),
    ).rejects.toThrow("registry unreachable");

    const spans = _exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.events.some(function _isException(e) { return e.name === "exception"; })).toBe(true);
  });

  it("reuses a caller-supplied requestId", async function _inheritsId()
  {
    const seen = await ___DoWithTrace("harvest.cycle", { requestId: "req-42" }, async function _work()
    {
      return ___GetContext()?.requestId;
    });
    expect(seen).toBe("req-42");
  });
});
