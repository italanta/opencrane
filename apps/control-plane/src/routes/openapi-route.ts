import { Router } from "express";

import { spec } from "../openapi/spec.js";

/**
 * Serves the OpenAPI 3.1 specification at GET /openapi.json.
 * No authentication required — the spec is a public contract document.
 */
export function openapiRouter(): Router
{
  const router = Router();

  router.get("/", function _getOpenApiSpec(_req, res)
  {
    res.json(spec);
  });

  return router;
}
