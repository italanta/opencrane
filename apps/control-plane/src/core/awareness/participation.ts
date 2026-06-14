import { Prisma, type PrismaClient } from "@prisma/client";

import { _LoadAwarenessRollout } from "./rollout-store.js";
import { _ResolveAwarenessVersion } from "./rollout.js";
import type { FleetParticipationReport, ParticipationEventInput, ParticipationSeverity, RecordParticipationResult, TenantParticipationStatus } from "./participation.types.js";

/** Default participation staleness window: not seen within this → non-participating. */
export const ___DEFAULT_PARTICIPATION_STALENESS_MS = 15 * 60 * 1000;

/**
 * Record a fleet participation event (P4B.5) idempotently and update the
 * tenant's monitoring rollup.
 *
 * Transport is the control-plane API with at-least-once delivery, so a
 * redelivered event (same `(tenant, idempotencyKey)`) is recorded exactly once;
 * the rollup (liveness, running version, Agent Card, counters) is only advanced
 * for genuinely new events.
 *
 * @param prisma - Prisma client.
 * @param input  - The participation event (tenant is the token identity, not body-supplied).
 * @returns Whether a new event was recorded, and whether it was a duplicate.
 */
export async function _RecordParticipationEvent(prisma: PrismaClient, input: ParticipationEventInput): Promise<RecordParticipationResult>
{
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const kind = _toPrismaKind(input.kind);

  // 1. Dedup-insert the event; a unique-constraint hit means an at-least-once
  //    redelivery — treat as a no-op success, do NOT re-advance the rollup.
  try
  {
    await prisma.participationEvent.create({
      data: {
        tenant: input.tenant,
        kind,
        idempotencyKey: input.idempotencyKey,
        outcome: input.outcome ?? null,
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt,
      },
    });
  }
  catch (err)
  {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
    {
      return { recorded: false, duplicate: true };
    }
    throw err;
  }

  // 2. Advance the rollup. Counters increment only for the relevant kind/outcome;
  //    the Agent Card and running version update only when the event carries them.
  const isExecution = input.kind === "skill_execution";
  const isViolation = isExecution && input.outcome === "policy-violation";
  const agentCard = input.kind === "agent_card" ? (input.payload ?? undefined) : undefined;

  await prisma.tenantParticipation.upsert({
    where: { tenant: input.tenant },
    create: {
      tenant: input.tenant,
      lastSeenAt: occurredAt,
      runningContractVersion: input.contractVersion ?? null,
      agentCard: agentCard as Prisma.InputJsonValue | undefined,
      skillExecutionCount: isExecution ? 1 : 0,
      policyViolationCount: isViolation ? 1 : 0,
    },
    update: {
      lastSeenAt: occurredAt,
      ...(input.contractVersion ? { runningContractVersion: input.contractVersion } : {}),
      ...(agentCard !== undefined ? { agentCard: agentCard as Prisma.InputJsonValue } : {}),
      skillExecutionCount: { increment: isExecution ? 1 : 0 },
      policyViolationCount: { increment: isViolation ? 1 : 0 },
    },
  });

  return { recorded: true, duplicate: false };
}

/**
 * Classify a tenant's participation severity (pure, P4B.5 monitoring model).
 *
 * Policy-violating executions are **critical** (page); non-participation (not
 * seen within the staleness window) or version **drift** are **warning** (the
 * locked `violation=page / drift=warn` model).
 *
 * @param args - Last-seen time (ms or null), running/expected versions, violation count, now, window.
 * @returns Participation/drift flags and the resulting severity.
 */
export function _ClassifyParticipation(args: {
  lastSeenAtMs: number | null;
  runningVersion: string | null;
  expectedVersion: string;
  policyViolations: number;
  nowMs: number;
  stalenessWindowMs: number;
}): { participating: boolean; drifted: boolean; severity: ParticipationSeverity }
{
  const participating = args.lastSeenAtMs !== null && args.nowMs - args.lastSeenAtMs <= args.stalenessWindowMs;
  const drifted = args.runningVersion !== null && args.runningVersion !== args.expectedVersion;
  const severity: ParticipationSeverity = args.policyViolations > 0
    ? "critical"
    : (!participating || drifted) ? "warning" : "ok";
  return { participating, drifted, severity };
}

/**
 * Build the fleet participation report across all tenants (P4B.5).
 *
 * Joins each tenant's rollup with the awareness rollout (to derive the *expected*
 * version for its wave) and classifies severity. A tenant with no rollup row has
 * never participated → warning.
 *
 * @param prisma            - Prisma client.
 * @param nowMs             - Current time in epoch ms (for staleness; injected for determinism).
 * @param stalenessWindowMs - Non-participation threshold; defaults to the 15-minute window.
 * @returns The aggregate fleet report.
 */
export async function _BuildFleetParticipationReport(prisma: PrismaClient, nowMs: number, stalenessWindowMs: number = ___DEFAULT_PARTICIPATION_STALENESS_MS): Promise<FleetParticipationReport>
{
  // 1. Load the inputs once: every tenant (+ its wave), each rollup, and the rollout.
  const [tenants, rollups, rollout] = await Promise.all([
    prisma.tenant.findMany({ select: { name: true, awarenessWave: true } }),
    prisma.tenantParticipation.findMany(),
    _LoadAwarenessRollout(prisma),
  ]);
  const rollupByTenant = new Map(rollups.map(function _entry(r) { return [r.tenant, r] as const; }));

  // 2. Classify each tenant against its rollout-expected version.
  const statuses: TenantParticipationStatus[] = tenants.map(function _classify(t): TenantParticipationStatus
  {
    const rollup = rollupByTenant.get(t.name) ?? null;
    const expectedVersion = _ResolveAwarenessVersion(rollout, t.awarenessWave).version;
    const lastSeenAtMs = rollup ? rollup.lastSeenAt.getTime() : null;
    const policyViolations = rollup?.policyViolationCount ?? 0;
    const cls = _ClassifyParticipation({
      lastSeenAtMs,
      runningVersion: rollup?.runningContractVersion ?? null,
      expectedVersion,
      policyViolations,
      nowMs,
      stalenessWindowMs,
    });
    return {
      tenant: t.name,
      lastSeenAt: rollup ? rollup.lastSeenAt.toISOString() : null,
      runningContractVersion: rollup?.runningContractVersion ?? null,
      expectedContractVersion: expectedVersion,
      participating: cls.participating,
      drifted: cls.drifted,
      policyViolations,
      severity: cls.severity,
    };
  });

  // 3. Aggregate the fleet counters from the per-tenant statuses.
  return {
    total: statuses.length,
    participating: statuses.filter(function _p(s) { return s.participating; }).length,
    drifted: statuses.filter(function _d(s) { return s.drifted; }).length,
    critical: statuses.filter(function _c(s) { return s.severity === "critical"; }).length,
    warning: statuses.filter(function _w(s) { return s.severity === "warning"; }).length,
    tenants: statuses,
  };
}

/**
 * Map the wire event-kind string to the Prisma enum value.
 * @param kind - The wire kind.
 */
function _toPrismaKind(kind: ParticipationEventInput["kind"]): Prisma.ParticipationEventCreateInput["kind"]
{
  switch (kind)
  {
    case "agent_card": return "AgentCard";
    case "skill_execution": return "SkillExecution";
    case "heartbeat": return "Heartbeat";
  }
}
