// Type-only import — erased at compile time, so it creates NO runtime dependency
// on @google-cloud/dns. The actual module is loaded lazily in _getDns().
import type { DNS } from "@google-cloud/dns";

/**
 * Minimal interface over the Cloud DNS record operations the OrgDomainProvisioner
 * needs. Injected so unit tests can substitute a fake without importing the SDK.
 */
export interface CloudDnsOperations
{
  /**
   * Ensure an A record exists for `name` pointing at `rrdatas`, idempotently. A
   * re-apply with the same data is a no-op; an existing record with different data
   * is replaced. `name` is the fully-qualified record name WITHOUT a trailing dot
   * (e.g. `*.acme.weownai.eu`); implementations append the dot Cloud DNS requires.
   *
   * @param name    - FQDN of the record (no trailing dot).
   * @param rrdatas - Record data (the ingress IP for an A record).
   * @param ttl     - Record TTL in seconds.
   */
  ensureARecord(name: string, rrdatas: string[], ttl: number): Promise<void>;

  /**
   * Delete the A record `name` if present; absence is a no-op (idempotent teardown).
   *
   * @param name - FQDN of the record (no trailing dot).
   */
  deleteARecord(name: string): Promise<void>;
}

/**
 * Production Cloud DNS client wrapper, scoped to a single managed zone.
 *
 * The `@google-cloud/dns` SDK is an OPTIONAL dependency loaded lazily via dynamic
 * import only when a DNS operation actually runs. This keeps the on-prem default
 * (and any non-GCP install) free of the cloud SDK at install and runtime — an
 * on-prem image can omit the package entirely and the control-plane still starts,
 * because this code path is never taken there. Mirrors the operator's
 * `GcpBucketClient` posture.
 *
 * Uses Application Default Credentials (Workload Identity on GKE); no static
 * credentials are read.
 */
export class CloudDnsClient implements CloudDnsOperations
{
  /** GCP project that owns the managed zone. */
  private readonly projectId: string;

  /** Cloud DNS managed-zone resource name (the terraform-created `<zone>-zone`). */
  private readonly managedZone: string;

  /** Lazily-initialised SDK client; null until the first DNS operation. */
  private dns: DNS | null = null;

  /**
   * @param projectId   - GCP project that owns the managed zone.
   * @param managedZone - Cloud DNS managed-zone resource name (terraform `<zone>-zone`).
   */
  public constructor(projectId: string, managedZone: string)
  {
    this.projectId = projectId;
    this.managedZone = managedZone;
  }

  /** @inheritdoc */
  public async ensureARecord(name: string, rrdatas: string[], ttl: number): Promise<void>
  {
    const dns = await this._getDns();
    const zone = dns.zone(this.managedZone);
    const fqdn = _withTrailingDot(name);

    // 1. Look up any existing A record at this name (zone records are keyed by
    //    name+type). A re-apply with identical data converges to a no-op.
    const [records] = await zone.getRecords({ name: fqdn, type: "A" });
    const desired = zone.record("A", { name: fqdn, ttl, data: rrdatas });

    if (records.length === 0)
    {
      await zone.createChange({ add: desired });
      return;
    }

    // 2. Same data already present → idempotent no-op (don't churn the zone).
    const current = records[0];
    if (_sameRecordData(_recordData(current.metadata?.data), rrdatas) && current.metadata?.ttl === ttl)
    {
      return;
    }

    // 3. Different data → atomic replace (delete old, add new in one change).
    await zone.createChange({ delete: current, add: desired });
  }

  /** @inheritdoc */
  public async deleteARecord(name: string): Promise<void>
  {
    const dns = await this._getDns();
    const zone = dns.zone(this.managedZone);
    const fqdn = _withTrailingDot(name);

    const [records] = await zone.getRecords({ name: fqdn, type: "A" });
    if (records.length === 0)
    {
      return; // Already gone — idempotent.
    }
    await zone.createChange({ delete: records[0] });
  }

  /**
   * Lazily import @google-cloud/dns and memoise the client. Throws a precise,
   * actionable error if the optional dependency is missing.
   */
  private async _getDns(): Promise<DNS>
  {
    if (this.dns)
    {
      return this.dns;
    }

    try
    {
      const sdk = await import("@google-cloud/dns");
      this.dns = new sdk.DNS({ projectId: this.projectId });
      return this.dns;
    }
    catch (err)
    {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        "@google-cloud/dns is required for Cloud DNS per-org record provisioning but could not be loaded. "
        + "Install the optional GCP DNS dependency (pnpm install, without --no-optional). "
        + `Original error: ${detail}`,
      );
    }
  }
}

/** Append the trailing dot Cloud DNS requires on FQDNs, idempotently. */
function _withTrailingDot(name: string): string
{
  return name.endsWith(".") ? name : `${name}.`;
}

/** Normalise a record's `data` (string | string[] | undefined) to a string array. */
function _recordData(data: string | string[] | undefined): string[]
{
  if (data === undefined)
  {
    return [];
  }
  return Array.isArray(data) ? data : [data];
}

/** Compare two record-data arrays as sets (order-insensitive). */
function _sameRecordData(a: string[], b: string[]): boolean
{
  if (a.length !== b.length)
  {
    return false;
  }
  const setB = new Set(b);
  return a.every(item => setB.has(item));
}
