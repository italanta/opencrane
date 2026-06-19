/**
 * Routes the global `console.*` methods through a structured pino logger.
 *
 * This is the "plug into console.log" seam: once bound, every `console.log`,
 * `console.warn`, etc. — first-party stragglers and noisy third-party
 * libraries alike — becomes a structured, context-tagged, trace-correlated log
 * record instead of an opaque stdout line.
 *
 * Safe against recursion: the logger writes JSON straight to a file descriptor
 * (see {@link ___CreateLogger}), never back through `console`, so forwarding a
 * `console.*` call into pino cannot re-enter the patched method.
 */
import { format } from "node:util";

import type { Logger } from "pino";

/** The `console` method names this module patches. */
const _METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** A `console` method name handled by {@link ___BindConsole}. */
type ConsoleMethod = (typeof _METHODS)[number];

/** Map each console method to the pino level it should emit at. */
const _LEVEL_FOR: Record<ConsoleMethod, "info" | "warn" | "error" | "debug"> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/**
 * Forward one captured `console.*` invocation to the matching pino level,
 * preserving structure when the first argument is an object or `Error`.
 * @param logger - Target logger.
 * @param level  - Pino level to emit at.
 * @param args   - Original `console.*` arguments.
 */
function _forward(logger: Logger, level: "info" | "warn" | "error" | "debug", args: unknown[]): void
{
  // 1. Empty call — emit an empty record so the call site is still observable.
  if (args.length === 0)
  {
    logger[level]("");
    return;
  }

  const [first, ...rest] = args;

  // 2. Error first — let pino serialise it under `err` and use the rest (or the
  //    error message) as the human-readable message.
  if (first instanceof Error)
  {
    logger[level]({ err: first }, rest.length > 0 ? format(...rest) : first.message);
    return;
  }

  // 3. Plain object first — treat it as pino's merge object (structured fields),
  //    formatting any remaining args into the message.
  if (typeof first === "object" && first !== null)
  {
    logger[level](first as Record<string, unknown>, rest.length > 0 ? format(...rest) : undefined);
    return;
  }

  // 4. Otherwise behave like console: printf-format every argument into one
  //    message string.
  logger[level](format(...args));
}

/**
 * Patch the global `console.*` methods to emit through `logger`.
 * @param logger - Logger that receives all forwarded console output.
 * @returns An `unbind` function that restores the original `console` methods.
 */
export function ___BindConsole(logger: Logger): () => void
{
  // 1. Capture the originals up front so unbind can restore them exactly and so
  //    forwarding never depends on the (now patched) live methods.
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  for (const method of _METHODS)
  {
    originals.set(method, console[method] as (...args: unknown[]) => void);
  }

  // 2. Replace each method with a forwarder bound to the logger.
  for (const method of _METHODS)
  {
    const level = _LEVEL_FOR[method];
    console[method] = function _patchedConsole(...args: unknown[]): void
    {
      _forward(logger, level, args);
    };
  }

  // 3. Hand back a restore closure for graceful shutdown / tests.
  return function _unbindConsole(): void
  {
    for (const method of _METHODS)
    {
      const original = originals.get(method);
      if (original)
      {
        console[method] = original;
      }
    }
  };
}
