import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _IsDevAuthMode } from "@opencrane/infra-auth";

/** Shape accepted on `POST /` — only an optional human-readable billing name. */
interface BillingAccountCreateRequest
{
  /** Optional human-readable billing name (company / individual). */
  displayName?: string;
}

/**
 * Router for the caller's own billing account — the prerequisite for creating an
 * organisation (ClusterTenant). Org creation is gated on HAVING a billing account,
 * which breaks the chicken-and-egg deadlock: a user becomes an org admin BY creating
 * an org, so the create cannot itself require pre-existing org-admin.
 *
 * IAM-first: the account is always keyed to the caller's OWN IdP-verified subject
 * (OIDC `sub`) taken from the session — never from request input — so a caller can
 * only ever create/read their own account. Create is idempotent on the subject.
 *
 * Posture (mirrors the platform's other guards):
 *   - No session under the dev-mode bypass (no OIDC, no env token) ⇒ a synthetic
 *     local subject so a fresh local install / the OPEN dev backend works.
 *   - No session in a real auth deployment ⇒ 401 (fail-closed).
 *
 * @param prisma - Prisma client used for persistence.
 * @returns Configured Express router.
 */
export function billingAccountsRouter(prisma: PrismaClient): Router
{
  const router = Router();

  /** Return the caller's own billing account, or 404 when they have none. */
  router.get("/me", async function _getMyBillingAccount(req, res, next)
  {
    try
    {
      const subject = _resolveSubject(req);
      if (!subject)
      {
        res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }

      const account = await prisma.billingAccount.findUnique({ where: { subject } });
      if (!account)
      {
        res.status(404).json({ error: "No billing account for this account", code: "BILLING_ACCOUNT_NOT_FOUND" });
        return;
      }

      res.json(_toContract(account));
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Create the caller's own billing account, idempotently. Keyed to the session's
   * IdP-verified subject; a repeat call returns the existing account (200) rather
   * than failing on the unique constraint, so the client can call it unconditionally.
   */
  router.post("/", async function _createBillingAccount(req, res, next)
  {
    try
    {
      const subject = _resolveSubject(req);
      if (!subject)
      {
        res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }

      const body = (req.body ?? {}) as BillingAccountCreateRequest;
      const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;
      const email = _resolveEmail(req);

      // Idempotent per subject: upsert so a repeat create is a no-op update, never a
      // unique-constraint 500. The subject is taken from the session, never the body.
      const account = await prisma.billingAccount.upsert({
        where: { subject },
        update: {},
        create: { subject, email, displayName },
      });

      // 201 when freshly created (created_at === updated_at), 200 when it already existed.
      const created = account.createdAt.getTime() === account.updatedAt.getTime();
      res.status(created ? 201 : 200).json(_toContract(account));
    }
    catch (err)
    {
      next(err);
    }
  });

  return router;
}

/** Contract projection of a billing-account row (stable field shapes). */
function _toContract(account: { id: string; subject: string; email: string | null; displayName: string | null; createdAt: Date; updatedAt: Date }): Record<string, unknown>
{
  return {
    id: account.id,
    subject: account.subject,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/**
 * Resolve the caller's subject from the session, fail-closed. Under the dev-mode
 * bypass (no real auth configured) a missing session yields a stable synthetic
 * subject so a fresh local install works; otherwise a missing session yields the
 * empty string and the caller is rejected with 401.
 */
function _resolveSubject(req: Parameters<Parameters<Router["post"]>[1]>[0]): string
{
  const authUser = (req as { session?: { authUser?: { sub?: string } } }).session?.authUser;
  const sub = typeof authUser?.sub === "string" ? authUser.sub.trim() : "";
  if (sub)
  {
    return sub;
  }
  return _IsDevAuthMode() ? "dev-local-subject" : "";
}

/** Resolve the caller's verified email from the session, if any (for reconciliation only). */
function _resolveEmail(req: Parameters<Parameters<Router["post"]>[1]>[0]): string | null
{
  const authUser = (req as { session?: { authUser?: { email?: string } } }).session?.authUser;
  const email = typeof authUser?.email === "string" ? authUser.email.trim().toLowerCase() : "";
  return email || null;
}
