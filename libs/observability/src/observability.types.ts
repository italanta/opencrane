/**
 * Shared type definitions for the `@opencrane/observability` package.
 *
 * Kept separate from the implementation files per the repository's
 * type-file separation rule.
 */

/**
 * Per-operation context propagated through `AsyncLocalStorage`.
 *
 * Seeded once at the entry of a request (HTTP middleware) or a background
 * operation (`___DoWithTrace`); every log line emitted within that async scope
 * automatically inherits these fields via the pino mixin, so no logger or id
 * needs to be threaded through function signatures.
 */
export interface RequestContext
{
  /** Correlation id shared by every log line and span of one request/operation. */
  requestId: string;
  /** Arbitrary structured fields merged into every log line within the scope. */
  extra: Record<string, unknown>;
}

/**
 * Options accepted by {@link ___CreateLogger}.
 */
export interface LoggerOptions
{
  /** Minimum level to emit; defaults to `LOG_LEVEL` env or `"info"`. */
  level?: string;
  /** Pretty-print to a human-readable transport (dev only); defaults to off in production. */
  pretty?: boolean;
  /** Destination file descriptor: 1 = stdout (default), 2 = stderr (used by the CLI). */
  destination?: 1 | 2;
}

/**
 * Options accepted by {@link ___StartTelemetry}.
 */
export interface TelemetryOptions
{
  /** Logical service name reported to the collector (e.g. `"control-plane"`). */
  serviceName: string;
  /** Service version stamped on every span; usually the package version. */
  serviceVersion?: string;
  /**
   * Whether to start the OpenTelemetry SDK at all.
   * Defaults to `true` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so the
   * CLI and local runs without a collector are silent by default.
   */
  enabled?: boolean;
}
