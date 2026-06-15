# OpenCrane Memory Layer (Cognee retrieval)

## Purpose

This document defines OpenCrane's **organizational memory / retrieval** architecture —
the Cognee-backed knowledge layer that tenant agents query during the agentic loop.

The memory layer provides:
- Tenant-safe retrieval for agent workflows.
- Deterministic write-through memory from source reads.
- AccessPolicy-compatible authorization behavior.
- Freshness controls to reduce stale-memory responses.

> **Not to be confused with** the per-agent workspace `MEMORY.md` file (an L2 tenant
> workspace doc seeded into the pod — see the agent-identity track / [obot.md](/integrators/mcp-gateway)
> for the workspace layering). *This* document is about the **Cognee retrieval plane**,
> a different thing entirely: org knowledge, not the agent's own scratch notes.

## Current state (2026-06)

The core path is **cut over and live**; some controls remain deferred:

- ✅ Retrieval is **direct** from the OpenClaw/Clawdbot runtime to Cognee; the control
  plane is *not* in the retrieval request path.
- ✅ The control plane translates **AccessPolicy outcomes into Cognee dataset
  memberships/grants** (with projection-drift detection + repair routes).
- ✅ Memory path cut over from PostgreSQL-only retrieval to **Cognee write-through**.
- ⏸️ **Deferred:** the full freshness/invalidation implementation (§Freshness below),
  source-permission propagation hardening, and self-hosted Cognee audit-log parity.

The sections below describe the full design; treat ⏸️-noted parts as target behavior.

## Architecture Summary

OpenCrane uses a source-agnostic memory pattern:

1. OpenClaw remains the source integration layer.
2. Cognee remains the memory orchestration layer.

```text
Org Sources (SoR) -> OpenClaw source tools -> Cognee datasets -> retrieval response
```

Org sources include SharePoint, Google Workspace, ERP systems, docs/wiki systems, ticketing systems, and similar enterprise systems.

### Connector Responsibilities

- OpenClaw handles source-specific auth, traversal, delta sync, and ACL extraction.
- OpenClaw normalizes content + metadata before persistence.
- Cognee handles memory storage/orchestration after bytes and metadata arrive.
- Retrieval responses preserve source ACL semantics through dataset placement and OpenClaw filtering.

## Write-Through Pattern

OpenCrane uses a tiered write-through approach:

1. Deterministic baseline ingest on successful source reads.
2. Explicit high-value persistence via agent "remember" behavior.

Baseline ingest writes metadata + summary so memory is useful by default. Explicit persistence captures high-signal findings with stronger provenance.

## Dataset Granularity and Isolation

Cognee datasets are the permission unit.

The target dataset model is hierarchical:
- Org-wide datasets (shared within tenant boundaries).
- Team-wide datasets.
- Project-wide datasets.
- Personal datasets.

Control-plane binds tenants to project/team/department datasets.

This design balances strict separation with manageable dataset growth.

## AccessPolicy Mapping

OpenCrane AccessPolicy remains the source of truth.

Mapping model:
- Control-plane manages which tenants/users can access which project and department datasets.
- Control-plane translates policy outcomes into Cognee permission grants.
- OpenClaw enforces request-time policy checks before and after retrieval as needed.

Policy-denied retrieval returns explicit `403` responses.

## Source-Permission Propagation

Source ACL semantics must be preserved during memory writes.

Chosen approach:
- Files are copied into Cognee datasets based on user/OpenClaw initiation.
- User action controls which data is moved where.
- OpenClaw performs policy checks before write and before response return.

If datasets are coarse, OpenClaw applies sub-dataset filtering before returning results.

## Freshness and Invalidation

Each memory record stores source freshness metadata (for example ETag/version).

Chosen behavior:
1. Re-fetch when the querying user is the originating user and memory is older than 1 day.
2. Re-fetch on explicit user request.
3. Re-fetch when source edits are detected through OpenClaw actions.

This keeps memory useful while avoiding blind trust in stale records.

## Audit and Observability

Baseline events and metrics should still be emitted for memory reads/writes and allow/deny outcomes.

Self-hosted Cognee audit-log parity is tracked as operational hardening and follows Cognee's self-hosted roadmap. It is not a hard blocker for initial memory cutover.

## Cutover Plan

1. Keep PostgreSQL retrieval path as fallback during migration.
2. Enable Cognee-backed retrieval behind tenant-level feature flags.
3. Validate auth parity, retrieval quality, and latency.
4. Promote Cognee path to default when cutover criteria pass.
5. Retain rollback switch to PostgreSQL path for incident response.

## Adoption Gate

Memory cutover requires:
- Dataset granularity implementation and documentation.
- AccessPolicy to Cognee mapping implementation + conformance tests.
- Source-permission propagation implementation.
- Freshness/invalidation controls in production.
- Cross-tenant and sub-tenant access tests passing.

Optional hardening after initial cutover:
- Verify self-hosted Cognee audit completeness against OpenCrane compliance requirements.

## Non-Goals

- Replacing source-system connectors with Cognee connectors.
- Treating memory as source of record for enterprise documents.
- Skipping AccessPolicy in favor of memory-runtime-only ACL logic.
