/**
 * Default redaction paths applied by every logger created through this package.
 *
 * Pino replaces the value at each path with `[Redacted]` before serialisation,
 * so secrets and bearer tokens never reach stdout / the collector / Cloud
 * Logging even when an object is logged wholesale.
 */

/**
 * Pino `redact.paths` entries covering the credential-bearing fields that flow
 * through the OpenCrane control-plane and its clients (auth headers, LiteLLM
 * master keys, OIDC secrets, DB URLs, k8s secret payloads).
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "headers.authorization",
  "authorization",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "masterKey",
  "client_secret",
  "clientSecret",
  "DATABASE_URL",
  "databaseUrl",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.masterKey",
  "*.client_secret",
];
