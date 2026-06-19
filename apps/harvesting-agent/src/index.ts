// OpenTelemetry must initialise before any instrumented module is imported.
import "./instrument.js";

import { PrismaClient } from "@prisma/client";

import { ___BindConsole, ___CreateLogger, ___ShutdownTelemetry, ___DoWithTrace } from "@opencrane/observability";

import { SlackConnector } from "./connectors/slack.connector.js";
import type { SlackConnectorConfig } from "./domain/harvesting-agents/harvesting-agent.types.js";
import { _IngestDocuments, _LoadCursor, _SaveCursor } from "./ingestion.js";
import { _RecordSyncMetrics, _StartMetricsServer } from "./metrics.js";

/** Application logger for the harvesting agent — structured JSON, trace-correlated. */
const log = ___CreateLogger("harvesting-agent");

// Route any stray console.* output through the structured logger.
const _unbindConsole = ___BindConsole(log);

/**
 * Read and validate Slack connector configuration from the environment.
 * Throws if required variables are missing.
 */
function _ReadSlackConfig(): SlackConnectorConfig
{
  const botToken = process.env.SLACK_BOT_TOKEN ?? "";
  if (!botToken)
  {
    throw new Error("SLACK_BOT_TOKEN environment variable is required");
  }

  const channelList = process.env.SLACK_CHANNEL_IDS ?? "";
  if (!channelList)
  {
    throw new Error("SLACK_CHANNEL_IDS environment variable is required (comma-separated channel IDs)");
  }

  const channelIds = channelList.split(",").map(function _trim(id) { return id.trim(); }).filter(Boolean);

  const maxMessagesPerCycle = Number(process.env.SLACK_MAX_MESSAGES_PER_CYCLE ?? "200");
  const syncIntervalMs = Number(process.env.SLACK_SYNC_INTERVAL_MS ?? "900000"); // 15 minutes default

  return {
    botToken,
    channelIds,
    maxMessagesPerCycle,
    syncIntervalMs,
  };
}

/**
 * Read and validate the Cognee base URL from the environment.
 * Throws when the required variable is absent.
 */
function _ReadCogneeEndpoint(): string
{
  const endpoint = process.env.COGNEE_ENDPOINT?.trim() ?? "";
  if (!endpoint)
  {
    throw new Error("COGNEE_ENDPOINT environment variable is required");
  }

  return endpoint;
}

/**
 * Read and validate the control-plane PostgreSQL URL from the environment.
 * Returns the DATABASE_URL needed by Prisma for cursor persistence.
 */
function _ReadDatabaseUrl(): string
{
  const url = process.env.DATABASE_URL ?? "";
  if (!url)
  {
    throw new Error("DATABASE_URL environment variable is required");
  }

  return url;
}

/**
 * Run a single Slack sync cycle: load cursor, fetch messages, push to Cognee, save cursor.
 *
 * @param connector      - Slack connector instance.
 * @param cogneeEndpoint - Base URL of the Cognee service.
 * @param prisma         - Prisma client for cursor table access.
 */
async function _RunSlackSyncCycle(
  connector: SlackConnector,
  cogneeEndpoint: string,
  prisma: PrismaClient,
): Promise<void>
{
  const source = "slack";

  // Trace the whole cycle as a `harvest.cycle` span so each sync (and its
  // Slack→Cognee child calls) is one attributable unit in the trace timeline.
  await ___DoWithTrace("harvest.cycle", { source }, async function _cycle()
  {
    log.info({ source }, "starting sync cycle");

    // 1. Load the persisted cursor from the last successful sync.
    const cursor = await _LoadCursor(prisma, source);

    // 2. Fetch new messages from Slack since the cursor timestamp.
    const { documents, nextCursor, errors } = await connector.sync(cursor);

    log.info({ source, documentCount: documents.length, errors: errors.length }, "sync fetched documents");

    // 3. Push normalized documents directly into Cognee.
    const { upsertedCount, skippedCount, failedCount } = await _IngestDocuments(
      cogneeEndpoint,
      documents,
      log,
    );

    // 4. Advance the cursor to the latest message timestamp if progress was made.
    if (nextCursor)
    {
      await _SaveCursor(prisma, source, nextCursor);
    }

    // 5. Record metrics for this cycle so the metrics server can serve them.
    const hasErrors = errors.length > 0 || failedCount > 0;
    _RecordSyncMetrics(source, upsertedCount, failedCount, !hasErrors, errors[0]);

    log.info({ source, upsertedCount, skippedCount, failedCount, nextCursor }, "sync cycle complete");
  });
}

/**
 * Main entry point for the harvesting agent.
 *
 * Starts the metrics server, initializes connectors from environment config,
 * and runs an incremental sync loop at the configured interval.
 */
async function _Main(): Promise<void>
{
  // 1. Read configuration — fail fast on missing required env vars.
  const slackConfig = _ReadSlackConfig();
  const cogneeEndpoint = _ReadCogneeEndpoint();
  _ReadDatabaseUrl();

  // 2. Start the metrics/health HTTP server so k8s probes work immediately.
  const metricsPort = Number(process.env.METRICS_PORT ?? "9090");
  _StartMetricsServer(metricsPort, log);

  // 3. Initialize the Prisma client for cursor persistence.
  const prisma = new PrismaClient();

  // 4. Initialize the Slack connector with the resolved configuration.
  const slackConnector = new SlackConnector(slackConfig, log);

  log.info(
    { channelIds: slackConfig.channelIds, intervalMs: slackConfig.syncIntervalMs, cogneeEndpoint },
    "harvesting agent started — Slack connector active",
  );

  // 5. Run the first sync cycle immediately on startup, then repeat at the configured interval.
  await _RunSlackSyncCycle(slackConnector, cogneeEndpoint, prisma);

  setInterval(async function _syncTick()
  {
    try
    {
      await _RunSlackSyncCycle(slackConnector, cogneeEndpoint, prisma);
    }
    catch (err)
    {
      log.error({ err }, "sync cycle failed; will retry next interval");
      _RecordSyncMetrics("slack", 0, 0, false, err instanceof Error ? err.message : String(err));
    }
  }, slackConfig.syncIntervalMs);
}

/**
 * Flush buffered spans to the collector and restore console before exiting.
 * @param signal - The signal that triggered shutdown.
 */
async function _shutdown(signal: string): Promise<void>
{
  log.info({ signal }, "shutting down harvesting agent");
  const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
  hardExit.unref();
  try
  {
    await ___ShutdownTelemetry();
  }
  finally
  {
    _unbindConsole();
    process.exit(0);
  }
}

process.on("SIGTERM", function _onSigterm() { void _shutdown("SIGTERM"); });
process.on("SIGINT", function _onSigint() { void _shutdown("SIGINT"); });

_Main().catch(function _onError(err: unknown)
{
  log.error({ err }, "harvesting agent crashed");
  process.exit(1);
});

