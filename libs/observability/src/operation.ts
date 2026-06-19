/**
 * Wrapper that turns any background unit of work (operator reconcile, CLI
 * command, harvesting cycle) into a traced, context-scoped operation.
 *
 * It opens an OpenTelemetry span, seeds the {@link RequestContext} so log lines
 * within the work inherit `requestId` + `operation`, and records the outcome,
 * duration, and any error on both the span and the logs.
 */
import { randomUUID } from "node:crypto";

import { SpanStatusCode, trace } from "@opentelemetry/api";

import { ___RunWithContext } from "./context.js";

/** Tracer shared by all operations started through this package. */
const _tracer = trace.getTracer("@opencrane/observability");

/**
 * Execute `fn` as a named, traced operation.
 *
 * A `requestId` is taken from `fields.requestId` when supplied (so an operation
 * can inherit a caller's correlation id) or minted otherwise. The span is
 * always ended and the error always re-thrown, so callers see normal control
 * flow while telemetry is captured transparently.
 * @param name   - Span / operation name (e.g. `"tenant.reconcile"`).
 * @param fields - Structured attributes attached to the span and context.
 * @param fn     - The work to run inside the operation scope.
 * @returns Whatever `fn` resolves to.
 */
export async function ___DoWithTrace<T>(
  name: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T>
{
  // 1. Derive the correlation id once so the span, context, and logs all agree.
  const requestId = typeof fields["requestId"] === "string" ? (fields["requestId"] as string) : randomUUID();
  const startedAt = performance.now();

  // 2. Open an active span so auto-instrumented child calls (HTTP, pg, fetch)
  //    nest under this operation in the trace.
  return _tracer.startActiveSpan(name, async function _runSpan(span)
  {
    span.setAttributes({ ...fields, requestId });

    // 3. Seed the async context so every log line within fn carries the ids.
    return ___RunWithContext({ requestId, extra: { operation: name, ...fields } }, async function _runWork()
    {
      try
      {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      }
      catch (err)
      {
        // Record on the span before re-throwing so failed operations are still
        // visible in Cloud Trace with their exception attached.
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      finally
      {
        span.setAttribute("duration_ms", Math.round(performance.now() - startedAt));
        span.end();
      }
    });
  });
}
