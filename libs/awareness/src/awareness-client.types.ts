import type { Citation } from "./citation.types.js";

/** A query for org context against the awareness index. */
export interface AwarenessQuery
{
  /** Natural-language query string. */
  query: string;
  /** Cognee datasets to search; omit to search all the pod is entitled to. */
  datasets?: string[];
  /** Maximum hits to return; defaults to the client's `defaultLimit`. */
  limit?: number;
}

/** A single raw hit returned by the Cognee search transport. */
export interface CogneeSearchHit
{
  /** The retrieved text/content. */
  content: string;
  /** Relevance score, when the backend provides one. */
  score?: number;
  /** Datasets the hit came from. */
  datasets?: string[];
  /** Source metadata used to build the citation (org-index ingest fields). */
  metadata?: Record<string, unknown>;
}

/**
 * The pluggable Cognee search transport. Defaults to a `fetch` POST to the
 * Cognee `/v1/search` endpoint; injectable so the SDK is testable without a
 * live backend and so the transport can be swapped without touching the client.
 *
 * Implementations MUST call Cognee directly (no control-plane mediation) —
 * that is the P4B.1 acceptance criterion.
 */
export type CogneeSearchTransport = (endpoint: string, query: AwarenessQuery, signal?: AbortSignal) => Promise<CogneeSearchHit[]>;

/** Options for constructing an {@link AwarenessClient}. */
export interface AwarenessClientOptions
{
  /** Base URL of the per-tenant Cognee service the pod retrieves from directly. */
  cogneeEndpoint: string;
  /** Override the search transport (tests / alternate backends). */
  search?: CogneeSearchTransport;
  /** Default maximum hits when a query omits `limit`. */
  defaultLimit?: number;
}

/** A citable awareness hit: retrieved content plus its guaranteed citation. */
export interface AwarenessHit
{
  /** The retrieved content. */
  content: string;
  /** Relevance score, or null when the backend gave none. */
  score: number | null;
  /** Datasets the hit came from. */
  datasets: string[];
  /** The complete, enforced citation for this hit. */
  citation: Citation;
}

/** The result of an awareness query. */
export interface AwarenessResult
{
  /** The awareness contract version the SDK produced this result under. */
  contractVersion: string;
  /** Echo of the query string. */
  query: string;
  /** Citable hits — every one carries a complete citation. */
  hits: AwarenessHit[];
  /** Count of raw hits dropped because they could not be cited. */
  droppedUncitable: number;
}
