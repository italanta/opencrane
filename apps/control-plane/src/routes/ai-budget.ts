import * as k8s from "@kubernetes/client-node";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { _DeleteAccountBudget, _GetAccountBudgets, _GetGlobalBudget, _GetLiteLlmKey, _GetTenantSpend, _PutAccountBudget, _PutGlobalBudget, _RevokeLiteLlmKey } from "../core/ai-budget/ai-budget.logic.js";

/**
 * Router for AI spend control and budget management.
 */
export function aiBudgetRouter(coreApi: k8s.CoreV1Api, prisma: PrismaClient): Router
{
  const router = Router();
  const deps = {
    coreApi,
    prisma,
    namespace: process.env.NAMESPACE ?? "default",
  };

  /** Returns global monthly spend ceiling. */
  router.get("/global", async function _getGlobalBudget(req, res)
  {
    await _GetGlobalBudget(req, res, deps);
  });

  /** Updates the global monthly spend ceiling. */
  router.put("/global", async function _putGlobalBudget(req, res)
  {
    await _PutGlobalBudget(req, res, deps);
  });

  /** Returns all per-account monthly spend ceilings. */
  router.get("/accounts", async function _getAccountBudgets(req, res)
  {
    await _GetAccountBudgets(req, res, deps);
  });

  /** Creates or updates the budget ceiling for a specific account. */
  router.put("/accounts/:userId", async function _putAccountBudget(req, res)
  {
    await _PutAccountBudget(req, res, deps);
  });

  /** Deletes a per-account spend ceiling. */
  router.delete("/accounts/:userId", async function _deleteAccountBudget(req, res)
  {
    await _DeleteAccountBudget(req, res, deps);
  });

  /** Returns a tenant spend summary sourced from LiteLLM usage APIs. */
  router.get("/:tenantName/spend", async function _getTenantSpend(req, res)
  {
    await _GetTenantSpend(req, res, deps);
  });

  /** Returns persisted or syncable LiteLLM key metadata for a tenant. */
  router.get("/:tenantName/litellm-key", async function _getLiteLlmKey(req, res)
  {
    await _GetLiteLlmKey(req, res, deps);
  });

  /** Revokes the active LiteLLM key for a tenant by deleting the mounted Secret and auditing the action. */
  router.post("/:tenantName/litellm-key/revoke", async function _revokeLiteLlmKey(req, res)
  {
    await _RevokeLiteLlmKey(req, res, deps);
  });

  return router;
}