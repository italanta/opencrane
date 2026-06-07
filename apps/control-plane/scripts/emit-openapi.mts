/**
 * Emit the OpenAPI 3.1 spec to openapi.json in the package root.
 *
 * Run via:  pnpm --filter @opencrane/control-plane emit-openapi
 *
 * CI drift gate:
 *   pnpm --filter @opencrane/control-plane emit-openapi
 *   git diff --exit-code apps/control-plane/openapi.json
 *
 * If the diff is non-empty, the committed openapi.json is stale.
 * Update the spec in src/openapi/spec.ts and re-run this script,
 * then commit both files together.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// tsx resolves .js → .ts, so this import works both in tsx (dev) and
// after tsc (when importing from dist/).
import { spec } from "../src/openapi/spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../openapi.json");

writeFileSync(outputPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
console.log(`OpenAPI spec written to ${outputPath}`);
