import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

import type { NormalizedDocument, SyncCursor } from "./domain/harvesting-agents/harvesting-agent.types.js";
import { _PushDocumentToCognee } from "./cognee-client.js";
import { _ValidateOrgIndexDocument } from "./org-index-schema-v2.js";

/**
 * Push a batch of normalized documents directly into Cognee.
 *
 * Each document is validated against the org index schema before being sent
 * to the Cognee `/v1/add` endpoint. Deduplication is delegated to Cognee;
 * this function does not perform content-hash comparisons or read-before-write.
 *
 * @param cogneeEndpoint - Base URL of the Cognee service (e.g. `http://cognee:8000`).
 * @param documents      - Batch of normalized documents produced by a connector.
 * @param log            - Scoped logger for ingest diagnostic messages.
 * @returns Ingestion statistics (upserted, skipped, failed counts).
 */
export async function _IngestDocuments(
  cogneeEndpoint: string,
  documents: NormalizedDocument[],
  log: Logger,
): Promise<{ upsertedCount: number; skippedCount: number; failedCount: number }>
{
  let upsertedCount = 0;
  const skippedCount = 0;
  let failedCount = 0;

  // 1. Process documents sequentially so transient Cognee failures on individual
  //    records are isolated and the cursor advances only when all pass.
  for (const doc of documents)
  {
    // 2. Reject non-conformant org index records early so malformed connector
    //    payloads never reach Cognee and corrupt the shared knowledge graph.
    const validation = _ValidateOrgIndexDocument(doc);

    if (!validation.valid)
    {
      log.warn(
        { source: doc.source, sourceId: doc.sourceId, issues: validation.issues },
        "skipping non-conformant org index document",
      );
      failedCount++;
      continue;
    }

    try
    {
      // 3. Push the document directly to Cognee; deduplication is handled there.
      await _PushDocumentToCognee(cogneeEndpoint, doc, log);
      upsertedCount++;
    }
    catch (err)
    {
      log.error({ err, source: doc.source, sourceId: doc.sourceId }, "failed to push document to Cognee");
      failedCount++;
    }
  }

  return { upsertedCount, skippedCount, failedCount };
}

/**
 * Load the current sync cursor for a source from the database.
 * Returns null when no cursor has been persisted yet (first sync).
 *
 * @param prisma  - Prisma client for harvesting_cursors table access.
 * @param source  - Logical source name (e.g. "slack").
 * @returns Cursor record or null.
 */
export async function _LoadCursor(prisma: PrismaClient, source: string): Promise<SyncCursor | null>
{
  const row = await prisma.harvestingCursor.findUnique({ where: { source } });

  if (!row)
  {
    return null;
  }

  return {
    source: row.source,
    cursorValue: row.cursorValue,
    lastSyncAt: row.lastSyncAt.toISOString(),
  };
}

/**
 * Persist an updated sync cursor after a successful sync cycle.
 *
 * @param prisma      - Prisma client for harvesting_cursors table access.
 * @param source      - Logical source name.
 * @param cursorValue - New cursor value (e.g. latest message timestamp).
 */
export async function _SaveCursor(prisma: PrismaClient, source: string, cursorValue: string): Promise<void>
{
  await prisma.harvestingCursor.upsert({
    where: { source },
    create: { source, cursorValue, lastSyncAt: new Date() },
    update: { cursorValue, lastSyncAt: new Date() },
  });
}

