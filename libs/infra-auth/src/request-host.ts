import type { Request } from "express";

/**
 * The request's effective host, honouring the `x-forwarded-host` set by the ingress proxy
 * (first value when comma-joined) and falling back to the `Host` header. Undefined when the
 * request carries no host. Shared by every host-derived path so they read the host one way.
 *
 * @param req - The incoming Express request.
 * @returns The host (no scheme), or undefined when none is present.
 */
export function _RequestHost(req: Request): string | undefined
{
  const forwardedHost = req.headers?.["x-forwarded-host"];
  if (typeof forwardedHost === "string") return forwardedHost.split(",")[0].trim();
  return typeof req.get === "function" ? req.get("host") : undefined;
}
