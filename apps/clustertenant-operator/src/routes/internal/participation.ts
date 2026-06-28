import { Router } from "express";
import * as k8s from "@kubernetes/client-node";
import type { PrismaClient } from "@prisma/client";

import { _RecordParticipationEvent } from "../../core/awareness/participation.js";
import type { ParticipationEventInput } from "../../core/awareness/participation.types.js";

/** Expected audience on the projected token tenant pods use to call this endpoint. */
const _EXPECTED_AUDIENCE = "control-plane";

/** Accepted participation event kinds. */
const _KINDS = new Set(["agent_card", "skill_execution", "heartbeat"]);

/**
 * Extract the tenant name from a `system:serviceaccount:<ns>:<name>` subject.
 * @param subject - Full Kubernetes ServiceAccount subject string.
 * @returns Tenant name segment, or null when the subject is malformed.
 */
function _ParseTenantNameFromSubject(subject: string): string | null
{
  const parts = subject.split(":");
  if (parts.length !== 4 || parts[0] !== "system" || parts[1] !== "serviceaccount")
  {
    return null;
  }
  return parts[3] ?? null;
}

/**
 * Internal endpoint for fleet participation events (P4B.5).
 *
 * Claws POST participation events (Agent Card advertisement, skill-execution
 * outcomes, heartbeats) from the `libs/awareness` SDK using the `control-plane`
 * projected ServiceAccount token. Transport is at-least-once with an
 * idempotency key (no new bus); duplicates are deduped server-side.
 *
 * **Identity:** the emitting tenant is taken from the TokenReview-validated
 * ServiceAccount identity — never from the request body — so a claw cannot
 * report events as another tenant.
 *
 * **This router is NOT behind `___AuthMiddleware`.** Authentication is inline via
 * TokenReview; NetworkPolicy further limits which pods can reach it.
 *
 * @see apps/clustertenant-platform/templates/networkpolicy-planes.yaml — NetworkPolicy.
 * @see apps/fleet-operator/src/tenants/deploy/3-deployment.ts — projected-token injection.
 *
 * @param prisma  - Prisma client.
 * @param authApi - Kubernetes authentication API for TokenReview.
 */
export function _RegisterInternalParticipation(prisma: PrismaClient, authApi: k8s.AuthenticationV1Api): Router
{
  const router = Router();

  /** Ingest one participation event from the authenticated tenant. */
  router.post("/", async function _postParticipation(req, res, next)
  {
    try
    {
      // 1. Extract + validate the projected token (audience-bound, TokenReview).
      const authHeader = req.headers["authorization"] ?? "";
      const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
      if (!token)
      {
        res.status(401).json({ error: "Missing Authorization header", code: "UNAUTHORIZED" });
        return;
      }

      const reviewBody = new k8s.V1TokenReview();
      reviewBody.spec = new k8s.V1TokenReviewSpec();
      reviewBody.spec.token = token;
      reviewBody.spec.audiences = [_EXPECTED_AUDIENCE];
      const review = await authApi.createTokenReview({ body: reviewBody });
      const status = review.status;

      if (!status?.authenticated || !status.audiences?.includes(_EXPECTED_AUDIENCE))
      {
        res.status(401).json({ error: "Token not authenticated for this audience", code: "UNAUTHORIZED" });
        return;
      }

      // 2. Derive the tenant from the token identity — never trust a body-supplied tenant.
      const tenant = _ParseTenantNameFromSubject(status.user?.username ?? "");
      if (!tenant)
      {
        res.status(403).json({ error: "Token subject is not a tenant ServiceAccount", code: "FORBIDDEN" });
        return;
      }

      // 3. Validate the event shape (kind + idempotency key are required).
      const body = (req.body ?? {}) as Partial<ParticipationEventInput>;
      if (typeof body.kind !== "string" || !_KINDS.has(body.kind))
      {
        res.status(400).json({ error: "kind must be one of agent_card|skill_execution|heartbeat", code: "VALIDATION_ERROR" });
        return;
      }
      if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim().length === 0)
      {
        res.status(400).json({ error: "idempotencyKey is required", code: "VALIDATION_ERROR" });
        return;
      }

      // 4. Record idempotently (tenant comes from the token, not the body).
      const result = await _RecordParticipationEvent(prisma, {
        tenant,
        kind: body.kind,
        idempotencyKey: body.idempotencyKey,
        occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
        contractVersion: typeof body.contractVersion === "string" ? body.contractVersion : undefined,
        outcome: body.outcome === "ok" || body.outcome === "policy-violation" ? body.outcome : undefined,
        payload: typeof body.payload === "object" && body.payload !== null ? body.payload : undefined,
      });

      // At-least-once: a duplicate is acknowledged 200 (idempotent), not an error.
      res.status(result.duplicate ? 200 : 201).json(result);
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}
