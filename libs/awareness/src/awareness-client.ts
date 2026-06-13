import { AWARENESS_CONTRACT_VERSION } from "./contract-version.js";
import { _BuildCitation } from "./citation.js";
import type { CitableSource } from "./citation.types.js";
import type { AwarenessClientOptions, AwarenessQuery, AwarenessResult, CogneeSearchHit, CogneeSearchTransport } from "./awareness-client.types.js";

/** Default maximum hits returned when a query omits `limit`. */
const _DEFAULT_LIMIT = 10;

/**
 * The Org Context / Awareness SDK (P4B.1).
 *
 * Every OpenClaw tenant pod consumes this client to retrieve org context
 * **directly from its per-tenant Cognee** — there is no control-plane retrieval
 * mediation in the hot path (the control plane governs grants/contract, not
 * each query). The client guarantees two fleet invariants:
 *   - every returned hit carries a complete citation (title + URI + freshness);
 *     uncitable hits are dropped and counted, never surfaced unattributed;
 *   - every result is stamped with the SDK's pinned contract version, so the
 *     canary/rollout machinery (P4B.3) can reason about fleet version skew.
 */
export class AwarenessClient
{
  /** Base URL of the per-tenant Cognee service. */
  private readonly cogneeEndpoint: string;

  /** The Cognee search transport (default `fetch` → `/v1/search`). */
  private readonly search: CogneeSearchTransport;

  /** Default hit limit applied when a query omits one. */
  private readonly defaultLimit: number;

  /**
   * @param options - Cognee endpoint, optional transport override, default limit.
   */
  constructor(options: AwarenessClientOptions)
  {
    this.cogneeEndpoint = options.cogneeEndpoint.replace(/\/+$/, "");
    this.search = options.search ?? _DefaultCogneeSearch;
    this.defaultLimit = options.defaultLimit ?? _DEFAULT_LIMIT;
  }

  /**
   * Retrieve org context for a query.
   *
   * @param query - The awareness query.
   * @param signal - Optional abort signal for cancellation/timeouts.
   * @returns Citable hits stamped with the contract version, plus the count of
   *   raw hits dropped for being uncitable.
   */
  async query(query: AwarenessQuery, signal?: AbortSignal): Promise<AwarenessResult>
  {
    // 1. Retrieve directly from Cognee — the SDK never routes queries through the
    //    control plane (P4B.1 acceptance).
    const limit = query.limit ?? this.defaultLimit;
    const raw = await this.search(this.cogneeEndpoint, { ...query, limit }, signal);

    // 2. Enforce the citation invariant: keep only hits that yield a complete
    //    citation, counting the rest so callers/metrics can see citation quality.
    let droppedUncitable = 0;
    const hits = raw.reduce<AwarenessResult["hits"]>(function _collect(acc, hit)
    {
      const citation = _BuildCitation(_toCitableSource(hit));
      if (!citation)
      {
        droppedUncitable += 1;
        return acc;
      }
      acc.push({
        content: hit.content,
        score: typeof hit.score === "number" ? hit.score : null,
        datasets: Array.isArray(hit.datasets) ? hit.datasets : [],
        citation,
      });
      return acc;
    }, []);

    // 3. Stamp the contract version so fleet rollout can reason about version skew.
    return { contractVersion: AWARENESS_CONTRACT_VERSION, query: query.query, hits, droppedUncitable };
  }
}

/**
 * Map a raw Cognee hit's metadata onto the citable-source fields the citation
 * builder reads (tolerant of both `uri`/`url` and snake/camel timestamp keys).
 *
 * @param hit - The raw search hit.
 */
function _toCitableSource(hit: CogneeSearchHit): CitableSource
{
  const md = hit.metadata ?? {};
  return {
    title: _str(md.title),
    uri: _str(md.uri),
    url: _str(md.url),
    sourceUpdatedAt: _str(md.source_updated_at) ?? _str(md.sourceUpdatedAt),
    freshnessRecordedAt: _str(md.freshness_recorded_at) ?? _str(md.freshnessRecordedAt),
  };
}

/**
 * Narrow an unknown metadata value to a string, else undefined.
 * @param value - The candidate value.
 */
function _str(value: unknown): string | undefined
{
  return typeof value === "string" ? value : undefined;
}

/**
 * Default Cognee search transport: a `fetch` POST to `<endpoint>/v1/search`.
 *
 * Sends `{ query, search_type, datasets }` and tolerantly parses the response
 * (Cognee variants return a bare array or a `{ results: [...] }` envelope).
 *
 * @param endpoint - Cognee base URL (no trailing slash).
 * @param query    - The awareness query.
 * @param signal   - Optional abort signal.
 * @returns The raw search hits.
 * @throws When Cognee responds non-2xx.
 */
const _DefaultCogneeSearch: CogneeSearchTransport = async function _search(endpoint, query, signal)
{
  const res = await fetch(`${endpoint}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: query.query, search_type: "GRAPH_COMPLETION", datasets: query.datasets ?? [], top_k: query.limit }),
    signal,
  });

  if (!res.ok)
  {
    throw new Error(`Cognee search failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as unknown;
  // Tolerate a bare array or a `{ results: [...] }` envelope; degrade to empty on
  // anything else (incl. a valid JSON `null`) rather than throwing in the pod.
  const rows = Array.isArray(body)
    ? body
    : (typeof body === "object" && body !== null && Array.isArray((body as { results?: unknown[] }).results))
      ? (body as { results: unknown[] }).results
      : [];
  return rows.map(function _toHit(row): CogneeSearchHit
  {
    const r = (row ?? {}) as { content?: unknown; text?: unknown; score?: unknown; datasets?: unknown; metadata?: unknown };
    return {
      content: typeof r.content === "string" ? r.content : typeof r.text === "string" ? r.text : "",
      score: typeof r.score === "number" ? r.score : undefined,
      // Keep only string dataset names — a malformed array (e.g. numbers) must not
      // violate the CogneeSearchHit contract downstream.
      datasets: Array.isArray(r.datasets) ? r.datasets.filter(function _isStr(d): d is string { return typeof d === "string"; }) : undefined,
      metadata: typeof r.metadata === "object" && r.metadata !== null ? (r.metadata as Record<string, unknown>) : undefined,
    };
  });
};
