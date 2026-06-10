import type { Logger } from "pino";

/**
 * Periodically verifies that the Obot MCP Gateway is reachable and logs a
 * warning when it is not.
 *
 * Obot self-syncs its MCP server catalog from the control-plane registry endpoint
 * (OBOT_SERVER_PROVIDER_REGISTRIES). The operator does not push catalog changes —
 * it only monitors gateway availability so that degraded states surface in logs
 * before tenants encounter connection failures.
 *
 * A single unhealthy poll does not block tenant reconciliation. Persistent failures
 * indicate a gateway restart is needed; the structured log fields allow downstream
 * alerting rules to fire on repeated failures.
 */
export class ObotHealthChecker
{
  private readonly _gatewayUrl: string;
  private readonly _log: Logger;
  private readonly _intervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _consecutiveFailures = 0;

  constructor(gatewayUrl: string, log: Logger, intervalMs = 30_000)
  {
    this._gatewayUrl = gatewayUrl;
    this._log = log.child({ component: "obot-health-checker" });
    this._intervalMs = intervalMs;
  }

  start(): void
  {
    this._log.info({ gatewayUrl: this._gatewayUrl }, "obot health checker started");
    this._timer = setInterval(async () =>
    {
      await this._check();
    }, this._intervalMs);
    // Also run immediately so startup issues surface without waiting for the first tick.
    void this._check();
  }

  stop(): void
  {
    if (this._timer !== null)
    {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _check(): Promise<void>
  {
    const url = `${this._gatewayUrl}/healthz`;
    try
    {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok)
      {
        if (this._consecutiveFailures > 0)
        {
          this._log.info({ gatewayUrl: this._gatewayUrl }, "obot gateway recovered");
        }
        this._consecutiveFailures = 0;
      }
      else
      {
        this._consecutiveFailures++;
        this._log.warn(
          { gatewayUrl: this._gatewayUrl, status: response.status, consecutiveFailures: this._consecutiveFailures },
          "obot gateway health check returned non-200",
        );
      }
    }
    catch (err)
    {
      this._consecutiveFailures++;
      const message = err instanceof Error ? err.message : "unknown error";
      this._log.warn(
        { gatewayUrl: this._gatewayUrl, err: message, consecutiveFailures: this._consecutiveFailures },
        "obot gateway unreachable",
      );
    }
  }
}
