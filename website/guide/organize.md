# Organize your company

As you add people, skills, and knowledge, you need a way to decide **who shares what**.
OpenCrane does this with **scopes**.

::: tip What's a scope?
A scope is the *reach* of something — how widely it's shared. There are four, from
narrowest to widest:

```
personal  ▸  project  ▸  department  ▸  org
 (one person) (a team)   (a division)   (everyone)
```
:::

## Departments and projects aren't folders

This is the key idea: **you don't create a department as an object.** There's no
"new department" button. Instead, a department (or project) is simply a **label** you
attach to people, skills, and knowledge. OpenCrane uses those labels to decide what's
shared and with whom.

That keeps things flexible — your org structure lives in the labels you choose, not
in a rigid hierarchy you have to maintain.

## How scopes show up

The same four scopes appear everywhere you share or restrict something:

- **Skills** are published at a scope and promoted to wider ones — a skill that starts
  *personal* can be promoted to *project*, then *department*, then *org*.
  → [Share skills](/guide/skills)
- **Knowledge** is organized into datasets by scope, so a department's documents only
  reach that department. → [Organizational knowledge](/guide/knowledge)
- **Access grants** allow or deny something for a person, team, or whole department.
  → [Control access](/guide/permissions)

## Grouping people

When you create an assistant you can tag the person's team:

```bash
oc tenants create --name alice --display-name "Alice" --email alice@example.com \
  --team engineering
```

That team label is what you then reference when you share skills with "engineering"
or give a department access to a tool — so everyone in that group is covered at once.

## A simple way to start

1. Decide your **departments** (e.g. Engineering, Sales, Support).
2. Tag each person's assistant with their `--team`.
3. Share company-wide skills and knowledge at **org** scope; keep team-specific things
   at **department** or **project** scope.

You can always widen a scope later — start narrow, promote as things prove useful.
