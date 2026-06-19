import type { Logger } from "pino";

/**
 * Periodically verifies that the Obot MCP Gateway is reachable and logs a
 * structured warning when it is not.
 *
 * Obot self-syncs its MCP server catalog from the control-plane registry
 * endpoint (`OBOT_SERVER_PROVIDER_REGISTRIES`).  The operator does not push
 * catalog changes — it only monitors gateway availability so that degraded
 * states surface in logs before tenants encounter connection failures.
 *
 * A single unhealthy poll does not block tenant reconciliation.  Persistent
 * failures indicate a gateway restart is needed; the `consecutiveFailures`
 * field in the structured log allows downstream alerting rules to fire on
 * repeated failures without generating noise on transient blips.
 *
 * @see platform/helm/templates/obot-mcp-gateway-deployment.yaml — deployment
 *   spec and liveness probe configuration for the Obot gateway pod.
 */
export class ObotHealthChecker
{
  /** Base URL of the Obot gateway (e.g. `http://<release>-mcp-gateway:8080`). */
  private readonly _gatewayUrl: string;

  /** Scoped logger that tags every message with `component: obot-health-checker`. */
  private readonly _log: Logger;

  /** How often (milliseconds) the health check fires.  Defaults to 30 seconds. */
  private readonly _intervalMs: number;

  /** Active interval handle; null when the checker is stopped. */
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Running tally of back-to-back failed polls; reset to 0 on recovery. */
  private _consecutiveFailures = 0;

  /**
   * @param gatewayUrl  - Base URL of the Obot MCP Gateway service.
   * @param log         - Pino logger instance; a child logger is created internally.
   * @param intervalMs  - Poll interval in milliseconds (default 30 000).
   */
  constructor(gatewayUrl: string, log: Logger, intervalMs = 30_000)
  {
    this._gatewayUrl = gatewayUrl;
    this._log = log.child({ component: "obot-health-checker" });
    this._intervalMs = intervalMs;
  }

  /**
   * Start the periodic health-check loop.
   *
   * An immediate check is performed on startup so issues surface without
   * waiting for the first interval tick to elapse.
   */
  start(): void
  {
    this._log.info({ gatewayUrl: this._gatewayUrl }, "obot health checker started");

    // 1. Schedule recurring checks at the configured interval.  A local
    //    variable captures `this` so the named callback can reach the instance
    //    without relying on arrow-function lexical binding.
    const checker = this;
    this._timer = setInterval(function _tick()
    {
      void checker._check();
    }, this._intervalMs);

    // 2. Run one check immediately so startup issues surface without waiting
    //    for the first tick — avoids a silent gap at boot time.
    void this._check();
  }

  /**
   * Stop the periodic health-check loop and release the interval handle.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  stop(): void
  {
    if (this._timer !== null)
    {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Perform a single health-check request against the gateway's `/api/healthz` endpoint.
   *
   * The path must match the liveness/readiness probe in the Obot Deployment
   * (`platform/helm/templates/obot-mcp-gateway-deployment.yaml`), which Obot
   * serves at `/api/healthz` — NOT `/healthz`. A mismatch here would make every
   * poll report the gateway as unhealthy even when it is fine.
   *
   * On success the consecutive-failure counter is reset (and a recovery log line
   * is emitted if the gateway had previously been unhealthy).  On failure the
   * counter is incremented and a structured warning is logged with enough context
   * for an alerting rule to fire on sustained outages.
   */
  private async _check(): Promise<void>
  {
    const url = `${this._gatewayUrl}/api/healthz`;

    try
    {
      // 1. Issue the health-check request with a hard 5-second timeout so a
      //    hung gateway never blocks the operator event loop indefinitely.
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });

      // 2. Treat any non-2xx response as unhealthy; increment the failure
      //    counter and emit a warning with the HTTP status for triage.
      if (!response.ok)
      {
        this._consecutiveFailures++;
        this._log.warn(
          { gatewayUrl: this._gatewayUrl, status: response.status, consecutiveFailures: this._consecutiveFailures },
          "obot gateway health check returned non-200",
        );
        return;
      }

      // 3. Successful poll — emit a recovery log line when returning from a
      //    degraded state so the timeline is clear in log aggregators, then
      //    reset the failure counter.
      if (this._consecutiveFailures > 0)
      {
        this._log.info({ gatewayUrl: this._gatewayUrl }, "obot gateway recovered");
      }
      this._consecutiveFailures = 0;
    }
    catch (err)
    {
      // 4. Network-level failure (DNS resolution failure, connection refused,
      //    timeout).  Log the error message without the full stack trace to
      //    keep log volume manageable during extended outages.
      this._consecutiveFailures++;
      const message = err instanceof Error ? err.message : "unknown error";
      this._log.warn(
        { gatewayUrl: this._gatewayUrl, err: message, consecutiveFailures: this._consecutiveFailures },
        "obot gateway unreachable",
      );
    }
  }
}
