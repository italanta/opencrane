import { execSync } from "node:child_process";

import { ___CreateLogger } from "@opencrane/observability";

/** Structured logger for the migration init container — JSON to stdout for central scraping. */
const _log = ___CreateLogger("control-plane-migrate");

/**
 * Standalone migration runner for the control plane database.
 * Intended for use as an init container or pre-start hook.
 * Runs `prisma migrate deploy` to apply pending migrations.
 */
function _runMigrations(): void
{
  _log.info("running database migrations");

  try
  {
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      // dist/scripts/migrate.js → up two levels to the control-plane package root,
      // where prisma/schema.prisma lives (the cwd `prisma migrate deploy` expects).
      cwd: new URL("../../", import.meta.url).pathname,
    });
    _log.info("migrations complete");
  }
  catch (err)
  {
    _log.error({ err }, "migration failed");
    process.exit(1);
  }
}

_runMigrations();
