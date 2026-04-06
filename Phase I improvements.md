# Phase I Improvements (Deferred While Starting Phase II)

This document captures improvements intentionally deferred so we can proceed with Phase II now.

## Decision

- We are moving forward with Phase II implementation.
- The items below are explicitly skipped for now and tracked here as a backlog.

## Deferred Improvements

### 1. Runtime hardening baseline in tenant pods

Status: Not implemented yet.

Scope:
- Add pod/container `securityContext` defaults for tenant runtime.
- Run as non-root user/group.
- Disable privilege escalation.
- Drop Linux capabilities.
- Enable seccomp runtime default profile.
- Use read-only root filesystem where compatible.

Why deferred:
- Requires runtime compatibility testing and may affect startup/update behavior.

### 2. Stronger least-privilege and file access limits

Status: Partially implemented.

Scope:
- Keep writable paths to a strict allowlist (`/data/openclaw`, `/data/secrets`, temp dirs as needed).
- Prevent accidental writes to base filesystem.
- Verify secret mounts remain read-only and minimally scoped.

Why deferred:
- Needs app/runtime validation and migration plan for any write-path assumptions.

### 3. Enforce tool allowlist policy at runtime

Status: Policy fields exist, enforcement is incomplete.

Scope:
- Enforce `mcpServers.allow/deny` from AccessPolicy in runtime behavior.
- Add deny/audit events when blocked tools are requested.
- Add conformance tests for allow/deny behavior.

Why deferred:
- Requires policy-to-runtime plumbing and test coverage expansion.

### 4. Tenant `policyRef` binding behavior

Status: Deferred architecture decision.

Scope:
- Define exact behavior of `Tenant.spec.policyRef` relative to selector-based AccessPolicy reconciliation.
- Implement deterministic precedence and conflict rules.

Why deferred:
- Needs product/architecture decision before code.

### 5. Tenant `skills` filtering behavior

Status: Deferred architecture decision.

Scope:
- Implement per-tenant skill filtering instead of mounting all shared skills.
- Decide mechanism: subdirectory mount, symlink subset, or alternative packaging.

Why deferred:
- Needs UX/security decision and skill distribution strategy.

### 6. Suspend logic aware of scheduled/background work

Status: Not implemented yet.

Scope:
- Prevent idle suspend when background jobs are running or jobs are due soon.
- Add a durable scheduler source of truth outside the pod.
- Wake suspended tenant pods when scheduled work is due.

Why deferred:
- Requires scheduler contract and state model that overlaps with Phase II work.

### 7. Managed runtime awareness contract for OpenClaw

Status: Not implemented yet.

Scope:
- Inject managed-cluster runtime mode env vars/config.
- Define capability contract endpoint/payload for runtime policy awareness.

Why deferred:
- Depends on final Phase II contracts for keying, policy, and scheduling.

## Entry Criteria to Pick These Up

Start implementation when Phase II core deliverables are in place and stable:
- Cost control path functional end-to-end.
- Key issuance/rotation flow stable in non-prod.
- Baseline e2e passing in CI.

## Exit Criteria for This Backlog

These deferred improvements are complete when:
- Hardening defaults are enforced and validated in e2e.
- Tool policy allow/deny is enforceable and audited.
- `policyRef` and `skills` behavior is deterministic and documented.
- Idle/suspend behavior is safe for scheduled/background workloads.
- Runtime managed-mode contract is documented and used by tenant runtime.
