# Share skills across teams

::: tip What's a skill?
A **reusable ability** you give to assistants — like installing an app. "Draft a
sales follow-up," "review a pull request," "summarise a support ticket" — build it
once, then share it with whoever should have it.
:::

Skills live in your own catalog. OpenCrane keeps each one **versioned** and
**security-scanned**, and only delivers it to assistants you've allowed.

## See the catalog

```bash
oc skills list
oc skills get <id>
```

## Add a skill

```bash
oc skills create \
  --name sales-follow-up \
  --version 1.0.0 \
  --digest sha256:… \
  --scope personal
```

A skill is added in **draft** and must pass a **security scan** before it can go live —
so an unsafe skill never reaches an assistant.

## Share it more widely (promotion)

This is the heart of skill sharing. Every skill has a **scope** — its reach — and you
**promote** it to wider scopes as it proves useful:

```
personal  ▸  project  ▸  department  ▸  org
 you build it   your team    your division   everyone
```

Promoting a skill to `department` means everyone in that department's assistants can
use it; promoting to `org` shares it company-wide. You can also pull it back
(demote) just as easily. Who actually receives a promoted skill is still governed by
[access grants](/guide/permissions), so you stay in control.

## Going deeper

Publishing, scanning, version pinning, and the exact promotion payloads are covered
in the [Skill registry deep dive](/integrators/skill-registry). For day-to-day use,
the create-and-promote idea above is all you need.
