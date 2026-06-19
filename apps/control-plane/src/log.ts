/**
 * Shared control-plane logger.
 *
 * A single root logger imported by both the bootstrap (`index.ts`) and the
 * core service modules so every line is consistent and — thanks to the
 * AsyncLocalStorage mixin in `@opencrane/observability` — automatically carries
 * the active request's `requestId` and the current span's `trace_id`, with no
 * logger threaded through function signatures.
 *
 * Safe to import from anywhere in the app because `index.ts` initialises
 * OpenTelemetry (`./instrument.js`) before this module's pino is loaded.
 */
import { ___CreateLogger } from "@opencrane/observability";
import type { Logger } from "@opencrane/observability";

/** Process-wide control-plane logger. */
export const _log: Logger = ___CreateLogger("control-plane");
