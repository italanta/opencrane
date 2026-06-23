import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import type { Logger } from "pino";

/**
 * Express 5 global error handler. Catches any error thrown from (or passed to
 * next() by) a route handler and formats it into the standard error envelope.
 *
 * Register this AFTER all routes so Express selects it only for errors.
 *
 * `detail` carries the raw error message in DEVELOPMENT only — handy without tailing logs.
 * It is STRIPPED in production (`NODE_ENV=production`) so Prisma messages, stack traces, and
 * ORM internals never reach a client there. Callers MUST always branch on `code`, never on a
 * human message or `detail`.
 *
 * @param log - Pino logger instance.
 */
export function _ErrorHandler(log: Logger)
{
  return function _handleError(err: unknown, req: Request, res: Response, _next: NextFunction): void
  {
    // The full error (incl. Prisma/stack) always goes to the server log.
    log.error({ err, url: req.url, method: req.method }, "unhandled request error");

    // Safety net: a Prisma unique-constraint violation (P2002) that a route did not map is
    // a client conflict, not a server error — return a clean 409 (no detail, any env) so the
    // ORM message can never leak through the generic 500 path. Routes SHOULD still catch P2002
    // themselves for a domain-specific message (e.g. POST /cluster-tenants → "workspace name").
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
    {
      res.status(409).json({ error: "A resource with these unique values already exists.", code: "CONFLICT" });
      return;
    }

    // Generic 500. `detail` is included in development only and STRIPPED in production, so
    // Prisma/stack internals never reach a client there.
    const body: Record<string, string> = { error: "An unexpected error occurred", code: "INTERNAL_ERROR" };
    if (process.env["NODE_ENV"] !== "production") body["detail"] = err instanceof Error ? err.message : String(err);
    res.status(500).json(body);
  };
}
