/**
 * OpenTelemetry SDK bootstrap.
 *
 * Apps import this module **first** (via a tiny `instrument.ts`, ideally also
 * preloaded with `node --import`) so auto-instrumentation patches `http`,
 * `express`, `pg`, and `fetch` before the application graph loads.
 *
 * Only traces are exported in-process (OTLP/http-protobuf → the in-cluster
 * collector → Cloud Trace). Logs travel as JSON on stdout and are scraped by
 * the collector's filelog receiver; the auto pino instrumentation injects
 * `trace_id`/`span_id` into those JSON records so logs and traces correlate.
 */
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";

import type { TelemetryOptions } from "./observability.types.js";

/** The running SDK, kept so {@link ___ShutdownTelemetry} can flush it. Null when disabled. */
let _sdk: NodeSDK | null = null;

/**
 * Start the OpenTelemetry SDK.
 *
 * No-op (returns immediately) when disabled — by default that is whenever no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, which keeps the CLI and local
 * runs silent without a collector.
 * @param opts - Service identity and an explicit enable override.
 */
export async function ___StartTelemetry(opts: TelemetryOptions): Promise<void>
{
  // 1. Decide whether to start at all. Default to enabled only when a collector
  //    endpoint is present so laptop / CI runs don't try to export to nothing.
  const enabled = opts.enabled ?? Boolean(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]);
  if (!enabled || _sdk)
  {
    return;
  }

  // 2. Seed service identity via env so the NodeSDK resource detector picks it
  //    up without importing the resources package directly.
  process.env["OTEL_SERVICE_NAME"] ??= opts.serviceName;
  if (opts.serviceVersion)
  {
    const existing = process.env["OTEL_RESOURCE_ATTRIBUTES"];
    const versionAttr = `service.version=${opts.serviceVersion}`;
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = existing ? `${existing},${versionAttr}` : versionAttr;
  }

  // 3. Build the SDK: OTLP trace exporter (endpoint from env) + the standard
  //    Node auto-instrumentations, with the noisy fs instrumentation disabled.
  _sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });

  // 4. Start synchronously-ish; NodeSDK.start() registers the providers and
  //    patches modules immediately.
  _sdk.start();
}

/**
 * Flush and stop the OpenTelemetry SDK.
 *
 * Must be awaited during graceful shutdown (and after a CLI command resolves)
 * so batched spans are exported before the process exits. No-op when telemetry
 * was never started.
 */
export async function ___ShutdownTelemetry(): Promise<void>
{
  if (!_sdk)
  {
    return;
  }
  try
  {
    await _sdk.shutdown();
  }
  finally
  {
    _sdk = null;
  }
}
