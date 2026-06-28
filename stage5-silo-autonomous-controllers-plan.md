# Stage 5 — silo-autonomous controllers

Status: **planned, not started.** Architectural correction (Jente, 2026-06-28): the **fleet-manager
stops at ClusterTenant lifecycle** and must watch **nothing inside** a silo; each
**clustertenant-manager runs its own in-silo controllers** over its **own namespace**, so a silo
stands on its own. This fixes the single-fleet-endpoint bug (the central operator injected one
fleet-namespace plane endpoint into every tenant) — a silo-local controller injects its own planes.

## Target split

| | fleet-manager (cluster-wide singleton) | clustertenant-manager (per silo) |
|---|---|---|
| Watches | the cluster-scoped **ClusterTenant** CR only | **Tenant** + **AccessPolicy** CRs in **its own namespace** |
| Reconciles | CT lifecycle: namespace + quota/LimitRange + per-org domain/TLS + Zitadel org + registry/billing | the tenant runtime: openclaw pods/ConfigMaps/Services, LiteLLM keys, idle-suspend, plane drift-repair, rollout canary, Obot health, gateway-proxy |
| RBAC | cluster-scoped (namespaces/clustertenants/quota) | **namespaced** Role over its own ns (tenants/accesspolicies + pods/configmaps/services/deployments/secrets) |
| Runs | ClusterTenantOperator + fleet API/registry/Zitadel | the API **+ all the in-silo controllers in one process** |

## Grounded facts (verified)

- ~5,100 LOC / 47 files move: `src/{tenants,policies,runtime-planes,gateway-proxy,tenant-rollout,mcp-gateway}`.
- The operator is **DB-less** — no Prisma; it drives k8s + calls the control-plane **internal HTTP
  API** (`/api/internal/{contract,tenant-models,…}`). After the move those calls hit the silo's
  **own** API (localhost / its own Service) — no Prisma refactor needed.
- Shared deps used by BOTH the staying ClusterTenantOperator and the moving controllers:
  `config.ts` (`_LoadOperatorConfig`, 424 LOC — note: re-exports `GcpHostingConfig` from `hosting/`,
  so the share must account for that coupling), `shared/watch-runner.ts`, `infra/k8s.ts`.
  The fleet CT-operator uses only a small subset of config (`ingressDomain`/`ingressIp`/`certManager*`).
- Default `<org>-default` Tenant: **silo seeds its own on boot** (reads the ClusterTenant CR owner;
  `default-tenant.ts` already lives in the silo). Revert the Stage-4 step-5 fleet-side seed.

## Slices (dependency-ordered — see TaskList #11–#15)

1. **S5.1** Operator config seam. REFINED: because `config.ts` re-exports `GcpHostingConfig` from
   `hosting/` (which moves to the silo with the tenant-deploy code), a shared *lib* would create a
   lib→app dependency. So **move `config.ts` + `shared/watch-runner.ts` + `infra/k8s.ts` + `hosting/`
   to the silo** (they are operator concerns), and give the fleet CT-operator a **small local config**
   (just `ingressDomain`/`ingressIp`/`certManager*`, read from its existing env). Not a separate lib.
   This slice is therefore NOT cleanly additive — it lands together with S5.2 (the controllers depend
   on these), so treat S5.1+S5.2 as one atomic relocation.
2. **S5.2** `git mv` the 6 controller dirs fleet→silo; fix imports (config/watch/k8s from S5.1 lib;
   `log` from the silo; contracts/infra-api unchanged).
3. **S5.3** Silo bootstrap: start the controllers over its own ns (`WATCH_NAMESPACE`=silo ns;
   internal-API base = self); seed its own default Tenant; graceful stop.
4. **S5.4** Trim fleet `index.ts` to ClusterTenantOperator + API only; revert step-5; drop the fleet
   `default-tenant-cr` seed helper.
5. **S5.5** RBAC (silo namespaced controller Role; fleet keeps cluster-scoped CT grants) + Helm
   (silo deployment gains controller env; fleet drops it, keeps CT-lifecycle domain/cert env) +
   move the operator tests fleet→silo. Validate: both build+test green; helm render (silo has the
   controller, fleet has only the CT operator).

## Note on the prior gating

This supersedes the deferred `clustertenantManager.enabled` install-gate concern: once the silo runs
its own controllers + the fleet runs none-of-them, the `CLUSTERTENANT_MANAGER_INTERNAL_URL` /
shared-LiteLLM cross-refs that blocked that gate dissolve (each silo is self-contained).
