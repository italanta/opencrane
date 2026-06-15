# Architecture

You don't need this page to use OpenCrane — but if you want to understand what's
running under the hood, here's the shape of the system.

## The pieces

- **Control plane** — the brain. A headless, API-first service (`/api/v1` + the `oc`
  CLI) that creates assistants, compiles access policies, owns configuration, and
  serves each assistant its effective settings. External UIs are just clients.
- **Assistant pods** — one isolated OpenClaw pod per tenant, each with its own
  private, encrypted storage. This is where conversations happen.
- **Supporting planes** — the control plane configures these; assistants reach them
  only with short-lived, scoped tokens:
  - **Tools (MCP gateway)** — brokers calls to external systems, keeping credentials
    server-side. → [MCP gateway](/integrators/mcp-gateway)
  - **Skills registry** — stores and delivers entitled skills. → [Skills](/integrators/skill-registry)
  - **Knowledge plane** — retrieval and memory. → [Retrieval & memory](/integrators/retrieval-memory)
  - **Operator** — reconciles assistants and repairs drift automatically.

```
        Control plane  (API + oc CLI)
        creates assistants · compiles access · owns config
                     │
        ┌────────────┼─────────────────────────┐
        ▼            ▼                           ▼
   assistant pods   tools (MCP) · skills · knowledge · operator
   (one per user)   configured by the control plane; reached
                    by assistants via short-lived scoped tokens
```

## Identity-first

Every interaction between these pieces is an authenticated, scoped, short-lived
credential exchange — not a shared secret. People sign in with OIDC; assistants use
audience-bound projected tokens (~10 min TTL); downstream tool credentials are
injected server-side and never reach an assistant pod or a browser. This is what
makes the per-user kill-switch and near-instant revocation possible.

## Isolation

Each assistant is isolated from every other — separate storage, separate identity,
default-deny networking. If you need to run **completely separate OpenCrane
instances** in one cluster (for example, several customers or business units),
see [Running multiple instances](/advanced/multi-instance) — most deployments never
need this.
