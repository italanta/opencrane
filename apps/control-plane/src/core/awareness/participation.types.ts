/** Monitoring severity for a tenant's fleet participation (locked P4B.0 model). */
export type ParticipationSeverity = "ok" | "warning" | "critical";

/** A fleet participation event ingested from a claw (P4B.5). */
export interface ParticipationEventInput
{
  /** Emitting tenant (derived from the projected-token identity, not the body). */
  tenant: string;
  /** Event kind. */
  kind: "agent_card" | "skill_execution" | "heartbeat";
  /** At-least-once idempotency key; a redelivery with the same key is deduped. */
  idempotencyKey: string;
  /** When the event occurred (claw clock); defaults to now when omitted. */
  occurredAt?: string;
  /** The awareness contract version the claw reports running (drift signal). */
  contractVersion?: string;
  /** For `skill_execution`: `ok` or `policy-violation`. */
  outcome?: "ok" | "policy-violation";
  /** Kind-specific payload (Agent Card manifest, skill digest/name, …). */
  payload?: Record<string, unknown>;
}

/** Outcome of ingesting a participation event. */
export interface RecordParticipationResult
{
  /** Whether a new event row was recorded. */
  recorded: boolean;
  /** Whether the event was a duplicate (idempotency key already seen). */
  duplicate: boolean;
}

/** Per-tenant participation status with its monitoring severity. */
export interface TenantParticipationStatus
{
  /** Tenant name. */
  tenant: string;
  /** Most recent event time (ISO), or null if never seen. */
  lastSeenAt: string | null;
  /** The contract version the tenant reports running. */
  runningContractVersion: string | null;
  /** The contract version the rollout expects this tenant to run. */
  expectedContractVersion: string;
  /** Whether the tenant is participating (seen within the staleness window). */
  participating: boolean;
  /** Whether the running version differs from the expected version. */
  drifted: boolean;
  /** Count of policy-violating skill executions. */
  policyViolations: number;
  /** Monitoring severity: policy-violation → critical; non-participation/drift → warning. */
  severity: ParticipationSeverity;
}

/** Fleet-wide participation report. */
export interface FleetParticipationReport
{
  /** Total tenants considered. */
  total: number;
  /** Number participating (seen within the window). */
  participating: number;
  /** Number whose running version drifted from expected. */
  drifted: number;
  /** Number with at least one policy violation (critical). */
  critical: number;
  /** Number at warning severity (non-participation or drift, no violations). */
  warning: number;
  /** Per-tenant statuses. */
  tenants: TenantParticipationStatus[];
}
