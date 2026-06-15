# Connect organizational knowledge

::: tip What's organizational knowledge?
Your company's own information — from Slack, email, documents, tickets — gathered
into a searchable index. With it, an assistant answers from **real company facts,
with citations**, instead of guessing.
:::

## How it works

- OpenCrane runs **collectors** that continuously pull in knowledge from your systems
  and organize it by [scope](/guide/organize) (personal, project, department, org).
- During a conversation, an assistant **looks things up directly** and answers with
  citations. OpenCrane never reads the conversation — it only decides which knowledge
  an assistant is allowed to see.
- What an assistant can reach is set by [access](/guide/permissions): a department's
  documents only reach that department.

## Keep every assistant consistent

So every assistant behaves the same way when it looks things up — same rules for
which sources to use, when to cite, and how fresh information must be — OpenCrane
applies a shared set of rules across the fleet. You roll changes out gradually (to a
few assistants first, then everyone) and can undo in one step:

```bash
oc awareness rollout show
oc awareness rollout set <version> --waves engineering,sales
oc awareness rollout promote
oc awareness rollout rollback
```

## Keep contexts from bleeding together

To stop one project's context from leaking into an unrelated chat, you can pin a
conversation to a scope:

```bash
oc sessions scope set <session> --principal alice --scope project:acme
oc sessions scope show <session>
oc sessions scope clear <session>
```

## Going deeper

How collection, datasets, and freshness work under the hood is in the
[Retrieval & memory deep dive](/integrators/retrieval-memory). Health dashboards are
in [Awareness SLOs](/operators/awareness-slos).
