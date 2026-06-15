# Manage cost

::: tip Why budgets?
AI usage costs money per request. Budgets let you cap spend — per person and
company-wide — so there are no surprises and no runaway bills.
:::

## Set a budget when you create an assistant

```bash
oc tenants create --name alice --display-name "Alice" --email alice@example.com \
  --budget 50        # monthly cap, in USD
```

## Adjust budgets later

```bash
oc budget set-global 5000        # company-wide monthly ceiling
oc budget global                 # show the global ceiling

oc budget set-account alice 75   # cap for one person
oc budget accounts               # all per-person caps

oc budget spend alice            # what Alice has spent this month
```

When someone hits their cap, their assistant pauses AI calls until the budget resets
or you raise it — it never silently overspends.

## Choose your AI provider

You're not tied to one vendor. Add the model providers your company uses, and switch
freely:

```bash
oc providers list
oc providers set claude <api-key>
oc providers set openai <api-key>
```

Use Claude, GPT, or open-source models without changing anything about your
assistants or skills. Budget and provider changes are recorded in the
[audit log](/guide/audit).
