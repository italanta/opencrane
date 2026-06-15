# Lib: awareness (`@opencrane/awareness`)

> Deep-dive for `libs/awareness`. Index: [`../app-specific.md`](../app-specific.md). Verified June 2026.

The **org-context SDK** imported by every OpenClaw tenant pod, pinned to a contract version. It lets a
pod query org knowledge **directly from its per-tenant Cognee** (no control-plane in the query hot
path) while enforcing two fleet invariants.

## Two invariants

1. **Every returned hit carries a complete citation** (title + URI + freshness). Uncitable hits are dropped and counted (`droppedUncitable`).
2. **Results are stamped with the SDK's pinned contract version**, so canary/rollout machinery can reason about version skew across a half-rolled-out fleet.

## `AwarenessClient` (`src/awareness-client.ts`)

`query(query, signal?)` posts to `{cogneeEndpoint}/v1/search` (default transport, `GRAPH_COMPLETION`, tolerant of bare-array vs `{results:[]}` envelopes; degrades to empty rather than throwing), filters to citable hits, and returns `AwarenessResult { contractVersion, query, hits[], droppedUncitable }`. The transport (`CogneeSearchTransport`) is pluggable for tests but **must** hit Cognee directly.

## Contract version (`src/contract-version.ts`)

`AWARENESS_CONTRACT_VERSION` (e.g. `awareness/v1alpha1`). `___AssertContractCompatible(peer)` throws on a **major**-version mismatch — a pod refuses to talk to an org index of an incompatible major, preventing silent schema mixing mid-rollout.

## Golden-suite conformance (`src/eval/`)

`___RunGoldenSuite(client, goldens, nowMs)` runs `GoldenQuery`s serially across four dimensions: **Citation**, **PolicySafety** (no hit from an out-of-scope dataset — hard gate), **Freshness** (within SLO, default 24h), **Correctness** (expected substrings present). `___SuiteGatesRollout(report)` is green only when `policyViolations === 0 && errors === 0`; citation/freshness/correctness are warnings. This suite **gates the awareness rollout** (policy violation = page, drift = warn).

## Data flow

[`harvesting-agent`](../apps/harvesting-agent.md) ingests org sources → Cognee. The control-plane governs grants, dataset membership, and rollout/contract versioning — **not** per-query evaluation. The pod uses this SDK to read Cognee, enforce citations, and stamp the version.
