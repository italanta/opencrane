/**
 * Per-request / per-operation context propagation via `AsyncLocalStorage`.
 *
 * The store is seeded once at an entry point ({@link ___RunWithContext}) and is
 * read by the pino mixin ({@link ___ContextMixin}) so every log line emitted
 * anywhere inside the async scope carries the same `requestId` plus any seeded
 * fields — without threading a logger or id through function signatures.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { RequestContext } from "./observability.types.js";

/** Process-wide async store holding the active {@link RequestContext}. */
const _store = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `ctx` installed as the active context for the entire async
 * subtree it spawns.
 * @param ctx - Context to install for the duration of `fn`.
 * @param fn  - Function to execute within the context.
 * @returns Whatever `fn` returns.
 */
export function ___RunWithContext<T>(ctx: RequestContext, fn: () => T): T
{
  return _store.run(ctx, fn);
}

/**
 * Return the active context, or `undefined` when called outside any
 * {@link ___RunWithContext} scope.
 * @returns The active context or `undefined`.
 */
export function ___GetContext(): RequestContext | undefined
{
  return _store.getStore();
}

/**
 * Merge a single field into the active context's `extra` bag so it appears on
 * every subsequent log line within the scope. No-op outside a context.
 * @param key   - Field name.
 * @param value - Field value.
 */
export function ___SetContextField(key: string, value: unknown): void
{
  const ctx = _store.getStore();
  if (ctx)
  {
    ctx.extra[key] = value;
  }
}

/**
 * Pino mixin: returns the fields to merge into every log record. Reads the
 * active context so logs are automatically correlated by `requestId`.
 * @returns Context fields, or an empty object outside any context.
 */
export function ___ContextMixin(): Record<string, unknown>
{
  const ctx = _store.getStore();
  if (!ctx)
  {
    return {};
  }
  return { requestId: ctx.requestId, ...ctx.extra };
}
