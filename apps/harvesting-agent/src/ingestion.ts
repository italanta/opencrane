import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

import type { NormalizedDocument, StoredOrgDocumentSnapshot, SyncCursor } from "./domain/harvesting-agents/harvesting-agent.types.js";
import { _ComputeContentHash } from "./connectors/slack.connector.js";
import { _ValidateOrgIndexDocument } from "./org-index-schema-v2.js";

/**
 * Write a batch of normalized documents into the org knowledge index.
 *
 * Each document is upserted using the (source, sourceId) unique key so that
 * re-ingesting the same document from a cursor replay is safe and idempotent.
 * Content-hash comparison is used to skip unchanged rows while a field-by-field
 * metadata drift check still allows policy-context updates without re-embedding.
 *
 * @param prisma    - Prisma client for org_documents table access.
 * @param documents - Batch of normalized documents produced by a connector.
 * @param log       - Scoped logger for ingest diagnostic messages.
 * @returns Ingestion statistics (upserted, skipped, failed counts).
 */
export async function _IngestDocuments(
  prisma: PrismaClient,
  documents: NormalizedDocument[],
  log: Logger,
): Promise<{ upsertedCount: number; skippedCount: number; failedCount: number }>
{
  let upsertedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  // 1. Process documents sequentially to avoid overwhelming the database
  //    with a large parallel write burst; batching can be added in Phase 3.
  for (const doc of documents)
  {
    // 2. Reject non-conformant org index records early so malformed connector
    //    payloads never become the shared fleet awareness baseline.
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

    // 3. Compute a stable content hash so actual text changes can trigger a
    //    downstream embedding refresh without rewriting identical payloads.
    const contentHash = _ComputeContentHash(doc.content);

    try
    {
      // 4. Look up any existing record so both content drift and metadata drift
      //    can be evaluated before deciding whether to write the row again.
      const existing = await (prisma as unknown as {
        orgDocument: {
          findUnique: (args: { where: { source_sourceId: { source: string; sourceId: string } } }) => Promise<StoredOrgDocumentSnapshot | null>;
        };
      }).orgDocument.findUnique({
        where: { source_sourceId: { source: doc.source, sourceId: doc.sourceId } },
      });
      const contentChanged = existing?.contentHash !== contentHash;
      const metadataChanged = _hasMetadataDrift(existing, doc);

      if (existing && !contentChanged && !metadataChanged)
      {
        skippedCount++;
        continue;
      }

      // 5. Upsert the document — create on first ingest, update if content changed.
      await (prisma as unknown as {
        orgDocument: {
          upsert: (args: {
            where: { source_sourceId: { source: string; sourceId: string } };
            create: object;
            update: object;
          }) => Promise<unknown>;
        };
      }).orgDocument.upsert({
        where: { source_sourceId: { source: doc.source, sourceId: doc.sourceId } },
        create: {
          source: doc.source,
          sourceId: doc.sourceId,
          owner: doc.owner,
          teamScope: doc.teamScope ?? null,
          departmentScope: doc.departmentScope ?? null,
          projectScope: doc.projectScope ?? null,
          sensitivityTags: doc.sensitivityTags,
          title: doc.title ?? null,
          content: doc.content,
          contentHash,
          confidentiality: doc.confidentiality ?? null,
          jurisdiction: doc.jurisdiction ?? null,
          retentionClass: doc.retentionClass ?? null,
          aclOrigin: doc.aclOrigin,
          sourceUpdatedAt: new Date(doc.sourceUpdatedAt),
          freshnessRecordedAt: new Date(doc.freshnessRecordedAt),
          ingestCursor: doc.ingestCursor,
          embeddingReady: false,
        },
        update: {
          owner: doc.owner,
          teamScope: doc.teamScope ?? null,
          departmentScope: doc.departmentScope ?? null,
          projectScope: doc.projectScope ?? null,
          sensitivityTags: doc.sensitivityTags,
          title: doc.title ?? null,
          content: doc.content,
          contentHash,
          confidentiality: doc.confidentiality ?? null,
          jurisdiction: doc.jurisdiction ?? null,
          retentionClass: doc.retentionClass ?? null,
          aclOrigin: doc.aclOrigin,
          sourceUpdatedAt: new Date(doc.sourceUpdatedAt),
          freshnessRecordedAt: new Date(doc.freshnessRecordedAt),
          ingestCursor: doc.ingestCursor,
          embeddingReady: contentChanged ? false : existing?.embeddingReady ?? false,
        },
      });

      upsertedCount++;
    }
    catch (err)
    {
      log.error({ err, source: doc.source, sourceId: doc.sourceId }, "failed to ingest document");
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
  const row = await (prisma as unknown as {
    harvestingCursor: {
      findUnique: (args: { where: { source: string } }) => Promise<{
        source: string;
        cursorValue: string;
        lastSyncAt: Date;
      } | null>;
    };
  }).harvestingCursor.findUnique({ where: { source } });

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
  await (prisma as unknown as {
    harvestingCursor: {
      upsert: (args: {
        where: { source: string };
        create: object;
        update: object;
      }) => Promise<unknown>;
    };
  }).harvestingCursor.upsert({
    where: { source },
    create: { source, cursorValue, lastSyncAt: new Date() },
    update: { cursorValue, lastSyncAt: new Date() },
  });
}

/**
 * Detect whether a stored org document row has drifted from the normalized document.
 *
 * @param existing - Stored document snapshot, if any.
 * @param document - Fresh normalized document candidate.
 * @returns True when metadata drift requires an update write.
 */
function _hasMetadataDrift(existing: StoredOrgDocumentSnapshot | null, document: NormalizedDocument): boolean
{
  if (!existing)
  {
    return true;
  }

  return existing.owner !== document.owner
    || existing.teamScope !== (document.teamScope ?? null)
    || existing.departmentScope !== (document.departmentScope ?? null)
    || existing.projectScope !== (document.projectScope ?? null)
    || existing.title !== (document.title ?? null)
    || existing.confidentiality !== (document.confidentiality ?? null)
    || existing.jurisdiction !== (document.jurisdiction ?? null)
    || existing.retentionClass !== (document.retentionClass ?? null)
    || existing.aclOrigin !== document.aclOrigin
    || existing.sourceUpdatedAt.toISOString() !== document.sourceUpdatedAt
    || existing.ingestCursor !== document.ingestCursor
    || !_stringArraysEqual(existing.sensitivityTags, document.sensitivityTags);
}

/**
 * Compare two string arrays for exact equality while preserving order semantics.
 *
 * @param left  - First candidate array.
 * @param right - Second candidate array.
 * @returns True when both arrays contain the same ordered string values.
 */
function _stringArraysEqual(left: string[], right: string[]): boolean
{
  if (left.length !== right.length)
  {
    return false;
  }

  for (let index = 0; index < left.length; index++)
  {
    if (left[index] !== right[index])
    {
      return false;
    }
  }

  return true;
}
