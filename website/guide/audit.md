# Review activity

::: tip What's in the audit log?
A record of every **administrative action** — who created or paused an assistant,
changed a policy, shared a skill, connected a tool, or adjusted a budget. It does
**not** record anyone's conversations with their assistant.
:::

## Look it up

```bash
oc audit list                          # most recent activity
oc audit list --tenant alice           # everything about one assistant
oc audit list --tenant alice --limit 50
```

Add `--output json` to feed it into other tools:

```bash
oc audit list --output json | jq '.[] | {time, actor, action}'
```

The log is kept accurate even if part of the system is briefly unavailable, so it's a
reliable record for reviews and compliance.
