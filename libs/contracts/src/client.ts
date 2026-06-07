import createFetchClient from "openapi-fetch";

import type { paths } from "./generated/api.js";

/**
 * Re-export the typed path map so consumers can type-check their own fetch calls.
 */
export type { paths };

/**
 * Create a typed HTTP client for the OpenCrane Control Plane API.
 *
 * Usage:
 *   import { ___CreateControlPlaneClient } from "@opencrane/contracts";
 *   const client = ___CreateControlPlaneClient("http://localhost:8080/api/v1", token);
 *   const { data, error } = await client.GET("/tenants");
 *
 * @param baseUrl - Full base URL including the /api/v1 prefix.
 * @param token   - Bearer token for Authorization header. If omitted the header is not sent.
 */
export function ___CreateControlPlaneClient(baseUrl: string, token?: string)
{
  // 1. Seed the default headers with the content-type all API endpoints expect.
  const headers: Record<string, string> = { "content-type": "application/json" };

  // 2. Attach the bearer token when one is available; omit the header for public endpoints.
  if (token)
  {
    headers.authorization = `Bearer ${token}`;
  }

  // 3. Return a fully-typed fetch client bound to the versioned base URL.
  return createFetchClient<paths>({ baseUrl, headers });
}

/** Type alias for the client returned by `___CreateControlPlaneClient`. */
export type ControlPlaneClient = ReturnType<typeof ___CreateControlPlaneClient>;
