import type { Request, RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";

import { _IsDevAuthMode } from "../auth/auth-mode.js";

/**
 * Resolve the caller's subject from the session, fail-closed. Under the dev-mode
 * bypass (no real auth configured) a missing session yields a stable synthetic
 * subject; otherwise the empty string (caller is unauthenticated).
 */
function _callerSubject(req: Request): string
{
  const sub = typeof req.session?.authUser?.sub === "string" ? req.session.authUser.sub.trim() : "";
  if (sub)
  {
    return sub;
  }
  return _IsDevAuthMode() ? "dev-local-subject" : "";
}

/**
 * Guard for **creating** a cluster tenant (organisation): the caller must be an
 * authenticated user who ALREADY has a billing account. It deliberately does NOT
 * require pre-existing org-admin — that would be a chicken-and-egg deadlock, since a
 * user becomes an org admin BY creating their first org. The billing account is the
 * gate that replaces it.
 *
 * Posture:
 *   1. No session — FAIL OPEN under the dev-mode bypass (no OIDC, no env token), so a
 *      fresh local install / the OPEN dev backend still works; FAIL CLOSED otherwise
 *      (401) — an anonymous caller in a real deployment must never create an org.
 *   2. Platform operator (env-seeded superadmin) — always allowed, no billing account
 *      required (they operate the fleet, not a customer billing relationship).
 *   3. Other established session — allow iff a billing account exists for the caller's
 *      subject; otherwise 403 with a code the SPA can use to route the user to billing.
 *
 * @param prisma - Prisma client for the billing-account lookup.
 * @returns Express middleware enforcing the billing gate (401/403 on denial).
 */
export function _RequireBillingAccountForOrgCreate(prisma: PrismaClient): RequestHandler
{
  return function _billingGate(req, res, next)
  {
    const authUser = req.session?.authUser;

    // 1. No session — honour the auth posture (dev opens the bypass, real auth denies).
    if (!authUser)
    {
      if (_IsDevAuthMode())
      {
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
      return;
    }

    // 2. Exception: the platform operator (the env-seeded superadmin) bootstraps and
    //    operates the fleet, not a customer billing relationship, so they may create
    //    organisations without a billing account.
    if (authUser.isPlatformOperator === true)
    {
      next();
      return;
    }

    // 3. Established non-operator session — require an existing billing account.
    const subject = _callerSubject(req);
    prisma.billingAccount.findUnique({ where: { subject }, select: { id: true } })
      .then(function _onAccount(account)
      {
        if (account)
        {
          next();
          return;
        }
        res.status(403).json({ error: "A billing account is required before creating an organisation.", code: "BILLING_ACCOUNT_REQUIRED" });
      })
      .catch(next);
  };
}

/**
 * Guard for **managing** an existing cluster tenant — destructive mutations
 * (PUT/DELETE on `/:name`) and the fleet list/get reads. The caller must be EITHER:
 *   - a platform operator (manages any org), OR
 *   - an `owner`/`admin` member of the specific org named in `req.params.name`.
 *
 * For the collection routes (list at `/`, with no `:name`) only a platform operator
 * passes — a per-org member has no business reading the whole fleet. Per-org members
 * reach their own org via `GET /:name`.
 *
 * Authority is derived purely from `OrgMembership` (owner/admin) and the session's
 * `isPlatformOperator` — never request input beyond the resource name in the path.
 *
 * Posture:
 *   1. No session — FAIL OPEN under the dev-mode bypass, FAIL CLOSED otherwise (401).
 *   2. Platform operator — allow.
 *   3. Owner/admin membership of the named org — allow; else 403.
 *
 * @param prisma - Prisma client for the membership lookup.
 * @returns Express middleware enforcing operator-or-owner/admin (401/403 on denial).
 */
export function _RequireOrgManager(prisma: PrismaClient): RequestHandler
{
  return function _orgManagerGate(req, res, next)
  {
    const authUser = req.session?.authUser;

    // 1. No session — honour the auth posture.
    if (!authUser)
    {
      if (_IsDevAuthMode())
      {
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
      return;
    }

    // 2. Platform operators manage any org at any scope.
    if (authUser.isPlatformOperator)
    {
      next();
      return;
    }

    // 3. Collection-scoped routes (no `:name`) are operator-only — a per-org member
    //    must not read the whole fleet. Deny here (operator already returned above).
    const orgName = typeof req.params.name === "string" ? req.params.name.trim() : "";
    if (!orgName)
    {
      _denyScope(res);
      return;
    }

    // 4. Resource-scoped: allow only an owner/admin member of the named org.
    const subject = _callerSubject(req);
    if (!subject)
    {
      _denyScope(res);
      return;
    }

    prisma.orgMembership.findUnique({
      where: { clusterTenant_subject: { clusterTenant: orgName, subject } },
      select: { role: true },
    })
      .then(function _onMembership(membership)
      {
        if (membership && (membership.role === "Owner" || membership.role === "Admin"))
        {
          next();
          return;
        }
        _denyScope(res);
      })
      .catch(next);
  };
}

/** Emit the canonical 403 envelope; never leak which specific check failed. */
function _denyScope(res: Parameters<RequestHandler>[1]): void
{
  res.status(403).json({ error: "Not authorized to manage this organisation.", code: "FORBIDDEN_ORG_SCOPE" });
}
