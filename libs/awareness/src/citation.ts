import type { Citation, CitableSource } from "./citation.types.js";

/**
 * Build a complete {@link Citation} from raw source metadata, or return null
 * when any required field is missing.
 *
 * Enforces the locked minimum citation format (title + URI + freshness). A hit
 * that cannot produce all three is *not* citable: the SDK drops it rather than
 * returning an unattributable result, which is what the citation-quality SLO
 * (P4B.0) requires. URI prefers `uri` then `url`; freshness prefers
 * `sourceUpdatedAt` (the system-of-record time) then `freshnessRecordedAt`.
 *
 * @param source - The raw source metadata from a retrieval hit.
 * @returns A complete citation, or null when one cannot be formed.
 */
export function _BuildCitation(source: CitableSource): Citation | null
{
  // 1. Title — required; an untitled source cannot be cited meaningfully.
  const title = _nonEmpty(source.title);
  if (!title)
  {
    return null;
  }

  // 2. URI — required link to the system of record; accept either field name.
  const uri = _nonEmpty(source.uri) ?? _nonEmpty(source.url);
  if (!uri)
  {
    return null;
  }

  // 3. Freshness — required; prefer the source-of-record time over capture time.
  const freshnessTimestamp = _nonEmpty(source.sourceUpdatedAt) ?? _nonEmpty(source.freshnessRecordedAt);
  if (!freshnessTimestamp)
  {
    return null;
  }

  return { title, uri, freshnessTimestamp };
}

/**
 * Whether a source can produce a complete citation.
 * @param source - The raw source metadata.
 */
export function _IsCitable(source: CitableSource): boolean
{
  return _BuildCitation(source) !== null;
}

/**
 * Trim a value and return it only when non-empty, else undefined.
 * @param value - The candidate string (possibly undefined).
 */
function _nonEmpty(value: string | undefined): string | undefined
{
  if (typeof value !== "string")
  {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
