# How OpenCrane works

A five-minute, plain-English tour of the main ideas. Once these click, the rest of
the docs are easy.

## The big picture

You run one **control plane** — the place you manage everything from (through the
`oc` command-line tool or the API). From there you hand out assistants to people and
decide what each one can do.

```
        You ──▶  Control plane  ──▶  an assistant for each person
                 (manage it all)      Alice · Bob · Carla · …
```

## The words you'll see

### Employee assistant
A private AI coworker for **one person**. It has its own secure storage and its own
web address, and it acts on that person's behalf. (In the API and CLI this is called
a *tenant* — same thing.) → [Create one](/guide/first-tenant)

### Skill
A **reusable ability** you can give to assistants — like installing an app. A skill
might be "write a sales follow-up" or "review a pull request." You build a skill
once and share it with whoever should have it. → [Share skills](/guide/skills)

### Tool (MCP)
A **connection to another system** — Slack, Jira, your CRM — so an assistant can
actually do things there, not just talk about them. These connections use a standard
called **MCP** (Model Context Protocol), so "an MCP server" just means "one connected
tool." → [Manage tools](/guide/tools)

### Organizational knowledge
Your company's information — from Slack, email, documents, tickets — gathered into a
searchable index so assistants can answer with real, cited facts instead of guessing.
→ [Connect knowledge](/guide/knowledge)

### Scopes: how sharing works
Everything you share has a **reach**: just one person, a project, a department, or
the whole organization.

```
personal  ▸  project  ▸  department  ▸  org
 (just me)   (a team)    (a division)   (everyone)
```

You don't "create" a department like a folder — a scope is simply a label you attach
to people, skills, and knowledge to decide how widely something is shared.
→ [Organize your company](/guide/organize)

### Access
Nothing is shared by default. You **grant** access — per person, project, department,
or org — to decide who can use which skills, tools, and knowledge.
→ [Control access](/guide/permissions)

## How it fits together

> You create an **assistant** for someone → grant it **access** to the **skills**,
> **tools**, and **knowledge** appropriate for their **scope** → they sign in and get
> to work. You set **budgets** and can review everything in the **audit log**.

Ready? → **[Get OpenCrane running](/guide/getting-started)**
