/**
 * Structured logger factory built on pino.
 *
 * Every app creates its root logger here so logging is consistent across the
 * fleet: JSON to stdout (or stderr for the CLI), context fields injected via a
 * mixin, secrets redacted, and — once {@link ___StartTelemetry} has run — every
 * record carries `trace_id`/`span_id` for correlation with Cloud Trace.
 */
import pino from "pino";
import type { Logger } from "pino";

import { ___ContextMixin } from "./context.js";
import { REDACT_PATHS } from "./redact.js";
import type { LoggerOptions } from "./observability.types.js";

/**
 * Create a configured root logger.
 *
 * Writes synchronous JSON straight to a file descriptor (never through
 * `console`), so it is safe to use together with {@link ___BindConsole} and never
 * spawns a worker-thread transport in production.
 * @param name - Service/component name stamped on every record.
 * @param opts - Optional level, pretty-print, and destination overrides.
 * @returns A pino {@link Logger}.
 */
export function ___CreateLogger(name: string, opts: LoggerOptions = {}): Logger
{
  // 1. Resolve the destination fd first — the CLI logs to stderr (2) to keep
  //    stdout reserved for `--output json`; everything else logs to stdout (1).
  const fd = opts.destination ?? 1;

  // 2. Resolve level and pretty-print from options or environment. Pretty mode
  //    uses a worker-thread transport, so it is dev-only and never the default
  //    in a container (NODE_ENV=production).
  const level = opts.level ?? process.env["LOG_LEVEL"] ?? "info";
  const pretty = opts.pretty ?? (process.env["NODE_ENV"] !== "production" && fd === 2);

  // 3. In pretty (dev) mode hand off to pino-pretty; the transport owns the fd.
  if (pretty)
  {
    return pino({
      name,
      level,
      mixin: ___ContextMixin,
      redact: [...REDACT_PATHS],
      transport: { target: "pino-pretty", options: { destination: fd, colorize: fd === 2 } },
    });
  }

  // 4. Production path: synchronous JSON to the raw fd. `sync: true` avoids the
  //    async buffer that can drop logs when a short-lived process exits.
  return pino(
    {
      name,
      level,
      mixin: ___ContextMixin,
      redact: [...REDACT_PATHS],
    },
    pino.destination({ fd, sync: true }),
  );
}

export type { Logger } from "pino";
