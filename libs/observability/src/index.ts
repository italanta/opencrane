/**
 * @opencrane/observability — centralized structured logging + execution tracing.
 *
 * One place to build a fleet-consistent logger, propagate a correlation id
 * through async work without threading it by hand, route stray `console.*`
 * calls into structured logs, and emit OpenTelemetry traces to the in-cluster
 * collector (which forwards to GCP Cloud Logging + Cloud Trace, or any OTLP
 * backend behind a Helm toggle).
 *
 * The side-effecting SDK bootstrap ({@link ___StartTelemetry}) is also available
 * via the dedicated `@opencrane/observability/telemetry` entry point so it can
 * be imported in isolation before the rest of the application graph.
 */
export { ___CreateLogger } from "./logger.js";
export type { Logger } from "./logger.js";
export { ___RunWithContext, ___GetContext, ___SetContextField, ___ContextMixin } from "./context.js";
export { ___BindConsole } from "./console-bind.js";
export { ___RequestContext } from "./express.js";
export { ___DoWithTrace } from "./operation.js";
export { ___StartTelemetry, ___ShutdownTelemetry } from "./telemetry.js";
export type { RequestContext, LoggerOptions, TelemetryOptions } from "./observability.types.js";
