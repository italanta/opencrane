import type { Logger } from "pino";

import type { NormalizedDocument } from "./domain/harvesting-agents/harvesting-agent.types.js";

/**
 * Resolve the Cognee dataset name for a normalized document.
 *
 * Dataset name is derived directly from the document's scope category and subject
 * identifier (e.g. `team/platform`, `department/engineering`, `project/opencrane`).
 * Falls back to `org` when no scope is set.
 *
 * @param document - Normalized document produced by a source connector.
 * @returns Cognee dataset name string.
 */
export function _ResolveDatasetName(document: NormalizedDocument): string
{
  if (document.scope && document.subject)
  {
    return `${document.scope}/${document.subject}`;
  }

  return "org";
}

/**
 * Push a single normalized document to Cognee via its REST ingest API.
 *
 * Sends document content and all policy-relevant metadata (ACL origin,
 * sensitivity tags, scope, subject, share list, freshness markers) to the
 * Cognee `/v1/add` endpoint so retrieval and permission enforcement can work
 * correctly.
 *
 * @param cogneeEndpoint - Base URL of the Cognee service (e.g. `http://cognee:8000`).
 * @param document       - Normalized document to push.
 * @param log            - Scoped logger.
 * @throws When the Cognee API responds with a non-2xx status.
 */
export async function _PushDocumentToCognee(
  cogneeEndpoint: string,
  document: NormalizedDocument,
  log: Logger,
): Promise<void>
{
  const dataset = _ResolveDatasetName(document);
  const url = `${cogneeEndpoint.replace(/\/+$/, "")}/v1/add`;

  log.debug(
    { sourceId: document.sourceId, dataset },
    "pushing document to Cognee",
  );

  const metadata: Record<string, unknown> = {
    source: document.source,
    source_id: document.sourceId,
    owner: document.owner,
    acl_origin: document.aclOrigin,
    sensitivity_tags: document.sensitivityTags,
    source_updated_at: document.sourceUpdatedAt,
    freshness_recorded_at: document.freshnessRecordedAt,
    ingest_cursor: document.ingestCursor,
  };

  if (document.scope)
  {
    metadata.scope = document.scope;
  }

  if (document.subject)
  {
    metadata.subject = document.subject;
  }

  if (document.shareList && document.shareList.length > 0)
  {
    metadata.share_list = document.shareList;
  }

  if (document.title)
  {
    metadata.title = document.title;
  }

  if (document.confidentiality)
  {
    metadata.confidentiality = document.confidentiality;
  }

  if (document.jurisdiction)
  {
    metadata.jurisdiction = document.jurisdiction;
  }

  if (document.retentionClass)
  {
    metadata.retention_class = document.retentionClass;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: document.content,
      dataset_name: dataset,
      metadata,
    }),
  });

  if (!response.ok)
  {
    throw new Error(`Cognee ingest failed with status ${response.status} for sourceId ${document.sourceId}`);
  }
}
