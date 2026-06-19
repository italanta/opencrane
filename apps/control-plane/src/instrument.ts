/**
 * OpenTelemetry bootstrap for the control-plane.
 *
 * Imported as the very first statement of `index.ts` (and, in containers, also
 * preloaded via `node --import ./dist/instrument.js`) so the SDK patches
 * `http`/`express`/`pg`/`fetch` before any instrumented module is loaded.
 * Keep this module tiny and dependency-light for that reason.
 */
import { ___StartTelemetry } from "@opencrane/observability/telemetry";

await ___StartTelemetry({ serviceName: "control-plane", serviceVersion: process.env["npm_package_version"] ?? "0.1.0" });
