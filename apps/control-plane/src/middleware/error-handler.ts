import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

/**
 * Express 5 global error handler. Catches any error thrown from (or passed to
 * next() by) a route handler and formats it into the standard error envelope.
 *
 * Register this AFTER all routes so Express selects it only for errors.
 *
 * @param log - Pino logger instance.
 */
export function _ErrorHandler(log: Logger)
{
  return function _handleError(err: unknown, req: Request, res: Response, _next: NextFunction): void
  {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, url: req.url, method: req.method }, "unhandled request error");
    res.status(500).json({ error: "An unexpected error occurred", code: "INTERNAL_ERROR", detail: message });
  };
}
