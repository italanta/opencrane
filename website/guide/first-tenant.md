# Create your first employee assistant

::: tip What's an employee assistant?
A private AI coworker for one person. It has its own secure storage and its own web
address, and it acts on that person's behalf. (In the API and CLI it's called a
*tenant*.)
:::

## Create one

```bash
oc tenants create \
  --name alice \
  --display-name "Alice Smith" \
  --email alice@example.com
```

That's it — Alice's assistant is now live at `https://alice.<your-domain>`, ready for
her to [sign in and use](/guide/connect).

You can set a few things up front:

```bash
oc tenants create \
  --name alice \
  --display-name "Alice Smith" \
  --email alice@example.com \
  --team engineering \      # the team she belongs to
  --budget 50               # monthly spend cap, in USD
```

The `--team` label is how you group people — see [Organize your company](/guide/organize).

## Manage assistants

```bash
oc tenants list             # everyone's assistants
oc tenants get alice        # details for one
oc tenants suspend alice    # pause it (frees resources)
oc tenants resume alice     # bring it back
oc tenants delete alice     # remove it
```

## What's next

A brand-new assistant starts locked down — it can chat, but it can't reach company
tools, skills, or knowledge until you allow it. Build it up:

- **[Let Alice sign in](/guide/connect)**
- **[Share skills with her](/guide/skills)** — reusable abilities
- **[Connect tools](/guide/tools)** — Slack, Jira, your CRM
- **[Add company knowledge](/guide/knowledge)** — so it answers with real facts
- **[Control access](/guide/permissions)** — decide exactly what it can use

Full command details live in the [CLI reference](/reference/cli).
