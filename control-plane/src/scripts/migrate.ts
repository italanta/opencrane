import { execSync } from "node:child_process";

/**
 * Standalone migration runner for the control plane database.
 * Intended for use as an init container or pre-start hook.
 * Runs `prisma migrate deploy` to apply pending migrations.
 */
function _runMigrations(): void
{
  console.log("[opencrane] Running database migrations...");

  try
  {
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      cwd: new URL("../../..", import.meta.url).pathname,
    });
    console.log("[opencrane] Migrations complete");
  }
  catch (err)
  {
    console.error("[opencrane] Migration failed:", err);
    process.exit(1);
  }
}

_runMigrations();
