/**
 * `@opencrane/infra-http` — shared Express/HTTP plumbing used by both the fleet-manager and
 * the clustertenant-manager API servers: the global error handler, the `/healthz` DB probe,
 * the per-IP rate limiter, and the public OpenAPI route. Each helper is app-agnostic (the
 * OpenAPI spec + the Prisma client are injected) so the two managers' divergent generated
 * Prisma clients both work without this lib importing either Prisma package.
 */
export * from "./error-handler.js";
export * from "./healthz.js";
export * from "./openapi-route.js";
export * from "./rate-limit.js";
