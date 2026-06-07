import createFetchClient from "openapi-fetch";

import type { paths } from "./generated/api.js";

/**
 * Re-export the typed path map so consumers can type-check their own fetch calls.
 */
export type { paths };

/**
 * Typed HTTP client for the OpenCrane Control Plane API.
 *
 * Usage:
 *   import { createControlPlaneClient } from "@opencrane/contracts";
 *   const client = createControlPlaneClient("http://localhost:8080/api/v1", token);
 *   const { data, error } = await client.GET("/tenants");
 *
 * @param baseUrl - Full base URL including the /api/v1 prefix.
 * @param token   - Bearer token for Authorization header. If omitted the header is not sent.
 */
export function createControlPlaneClient(baseUrl: string, token?: string)
{
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (token)
  {
    headers.authorization = `Bearer ${token}`;
  }

  return createFetchClient<paths>({ baseUrl, headers });
}

/** Type alias for the client returned by `createControlPlaneClient`. */
export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
