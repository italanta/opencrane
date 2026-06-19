/**
 * OpenTelemetry bootstrap for the `oc` CLI.
 *
 * A complete no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the default on a
 * laptop), so normal CLI use carries zero overhead. When an endpoint *is*
 * configured (e.g. `oc` running in CI against the cluster), the auto HTTP
 * instrumentation propagates trace context to the control-plane so a command
 * and the server work it triggers appear in one trace.
 *
 * Imported first in `index.ts` so instrumentation is installed before the
 * contracts HTTP client loads.
 */
import { ___StartTelemetry } from "@opencrane/observability/telemetry";

await ___StartTelemetry({ serviceName: "oc-cli", serviceVersion: process.env["npm_package_version"] ?? "0.1.0" });
