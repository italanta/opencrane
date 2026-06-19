/**
 * OpenTelemetry bootstrap for the operator.
 *
 * Imported first in `index.ts` (and preloaded via `node --import` in the
 * container) so the SDK patches `http`/`@kubernetes/client-node`/`fetch` before
 * any instrumented module loads. Keep tiny and dependency-light.
 */
import { ___StartTelemetry } from "@opencrane/observability/telemetry";

await ___StartTelemetry({ serviceName: "operator", serviceVersion: process.env["npm_package_version"] ?? "0.1.0" });
