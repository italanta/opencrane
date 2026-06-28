# Zitadel service-account key rotation

How to rotate the platform's Zitadel service-account key — the master IdP credential
that the **fleet-manager** uses to provision and manage ClusterTenant organisations — using
the safe validate-then-swap procedure.

> See also: [Authentication](/security/identity) (how the Zitadel SA key fits into the OIDC model),
> [Fleet and silo operating model](/operators/fleet-silo-model) (how the fleet-manager owns the Zitadel SA key),
> [Runbook](/operators/runbook) (general operational procedures),
> [Networking & isolation](/operators/networking) (the platform network model).

---

## What this key is and why it matters

The **fleet-manager** authenticates to the Zitadel Management API as a **service account**
using a key-pair JSON file (the Zitadel "SA key"). This credential is used to:

- Create and tear down per-organisation Zitadel Orgs on ClusterTenant provisioning.
- Grant the ClusterTenant owner admin rights inside their Zitadel Org.
- Set and update OIDC application redirect URIs (e.g. when a vanity domain is added).

The SA key must hold the Zitadel **instance-level `IAM_OWNER` role** — an
instance-scoped privilege that allows org create and delete operations. Losing or
leaking this credential is a platform-level incident.

::: info Fleet-manager only
The SA key and its rotation apply only to the **fleet-manager** deployment in
`opencrane-system`. The per-silo **clustertenant-manager** never holds this key and
makes no Zitadel Management API calls. The rotation requires `ZITADEL_MGMT_API_URL`,
`ZITADEL_MGMT_SA_KEY`, and `PLATFORM_BASE_DOMAIN` all set on the fleet-manager pod —
configured via `fleetManager.zitadel.*` in Helm values.
:::

---

## The safe-rotation invariant

The rotation procedure enforces a **validate-then-swap** invariant: the live key is
replaced only after the candidate key passes both of the following checks:

1. **Token exchange succeeds** — the candidate can authenticate to the Zitadel token
   endpoint via the JWT-bearer SA grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`).
2. **Instance-scope probe passes** — the resulting access token holds the
   `IAM_OWNER` scope the platform depends on (verified by a non-destructive probe
   against the Zitadel instance API).

If either check fails, the API returns `422`, the old key stays active, and no change
is made. The CLI exits non-zero and prints which check failed so the operator can
diagnose before retrying.

Persistence is also required before the in-memory swap. The control plane writes the
validated key to the `ZITADEL_MGMT_SECRET_NAME` Kubernetes Secret first. If the
Secret write fails, the live key is not swapped — a restart would otherwise revert to
the old (potentially revoked) key, so the control plane refuses to proceed. A
misconfigured persistence path (the env var unset) is rejected with `409` before
validation even starts.

```
┌──────────────────────────────────────────────────────────┐
│  POST /api/v1/admin/zitadel/sa-key:rotate                │
│                                                          │
│  1. Normalise the candidate key JSON                     │
│  2. Check Secret persistence is configured  ─── 409 ────┤
│  3. Validate the candidate against the live              │
│     Zitadel instance:                                    │
│       a. jwt-bearer token exchange          ─── 422 ────┤
│       b. IAM_OWNER scope probe              ─── 422 ────┤
│  4. Persist the validated key to the Secret ─── 500 ────┤
│  5. Swap the in-memory client + clear token              │
│     cache (atomic)                                       │
│  6. Return { rotated: true, keyId, previousKeyId }       │
└──────────────────────────────────────────────────────────┘
```

Source:
[`apps/fleet-operator/src/routes/admin/zitadel-key.ts`](https://github.com/italanta/opencrane/blob/main/apps/fleet-operator/src/routes/admin/zitadel-key.ts).

---

## Rotation runbook

Follow these steps when rotating the Zitadel SA key in production. Do not skip the
validation step or revoke the old key before confirming the rotation succeeded.

### Step 1 — mint a new key in Zitadel

In the Zitadel console, navigate to the service account that the control plane uses
(the one whose `userId` matches the current key's `userId` field):

1. Open the service account's **Keys** tab.
2. Click **Add key** and choose **JSON** as the key type.
3. Download the generated JSON file and store it securely (e.g. a secrets manager).
   The file has the shape `{ "keyId": "…", "key": "-----BEGIN RSA PRIVATE KEY…", "userId": "…" }`.

Do **not** revoke the old key yet. Both keys are valid at this point.

### Step 2 — rotate via the API or CLI

::: tip Prefer --key-file
Pass the key JSON via `--key-file` so the key material stays off your shell history
and process arguments. Inline `--key` is available for scripting but should be
avoided in production.
:::

```bash
# Using the CLI (recommended)
oc admin zitadel rotate-key --key-file /path/to/new-key.json

# Using the API directly
curl -X POST \
  -H "Authorization: Bearer $OPENCRANE_API_TOKEN" \
  -H "Content-Type: application/json" \
  https://control.example.com/api/v1/admin/zitadel/sa-key:rotate \
  --data-raw "{ \"serviceAccountKey\": $(cat /path/to/new-key.json | jq -c .) }"
```

On success the CLI prints:

```
✓ Zitadel SA key rotated successfully.
  newKeyId      : <new-key-id>
  previousKeyId : <old-key-id>
```

On validation failure it prints which check failed and exits non-zero — the old key
remains active. Diagnose the failure before retrying.

### Step 3 — verify the new key is working

After a successful rotation, confirm that the control plane can still provision
ClusterTenant organisations by creating a test ClusterTenant (or re-provisioning an
existing one with a forced reconcile). Check the control-plane logs:

```bash
kubectl logs -n opencrane-system deployment/opencrane-fleet-manager --tail 50 | grep zitadel
```

A healthy log line looks like:

```
{"level":30,"msg":"provisioned Zitadel org for ClusterTenant","orgId":"…","orgName":"…"}
```

### Step 4 — revoke the old key in Zitadel

Only after confirming the rotation succeeded, return to the Zitadel console and delete
the old key from the service account's **Keys** tab using the `previousKeyId` printed
in step 2.

---

## Access control

The rotation endpoint is gated behind the **platform-operator** role check
(`_RequirePlatformOperator` middleware). Only a caller whose OIDC session grants
`isPlatformOperator` (via the `OPENCRANE_PLATFORM_OPERATOR_GROUPS` env or the seed
email) can invoke it. An authenticated but non-operator caller receives `403`.

The Kubernetes RBAC for the rotation path is `patch`-only on the single named Secret
(`ZITADEL_MGMT_SECRET_NAME`). The fleet-manager's ServiceAccount does not hold `get`
on the Secret — it reads the initial key at boot from `ZITADEL_MGMT_SA_KEY` env (set
from the Secret via the Helm template at `fleetManager.zitadel.existingSecret`) and patches the Secret only during rotation.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
These environment variables apply to the **fleet-manager** pod in `opencrane-system`. Set them via `fleetManager.zitadel.*` in Helm values — not directly.

| Variable | Required | Helm value | Purpose |
|----------|----------|------------|---------|
| `ZITADEL_MGMT_API_URL` | Yes | `fleetManager.zitadel.mgmtApiUrl` | Zitadel instance base URL (e.g. `https://your-instance.zitadel.cloud`) |
| `ZITADEL_MGMT_SA_KEY` | Yes | from `fleetManager.zitadel.existingSecret` | Service-account key JSON (set from the Secret at pod start) |
| `ZITADEL_MGMT_SECRET_NAME` | Yes (rotation) | derived from `fleetManager.zitadel.existingSecret` | Name of the Kubernetes Secret to patch during rotation |
| `PLATFORM_BASE_DOMAIN` | Yes | `--base-domain` at install | Base domain used to derive per-org redirect URIs |

`ZITADEL_MGMT_SECRET_NAME` must be set for the rotation endpoint to accept requests.
If it is unset the endpoint returns `409` immediately — an in-memory-only swap would
revert to the old key on the next pod restart, so the fleet-manager refuses to proceed.

---

## Incident response

### Rotation returns 422 (validation failed)

The candidate key failed the token exchange or the `IAM_OWNER` scope probe. The old
key is untouched. Check:

- The key JSON is complete and valid (has `keyId`, `key`, `userId`).
- The service account in Zitadel still exists and the key has not expired.
- The service account holds the **instance-level** `IAM_OWNER` role (not org-level).
- `ZITADEL_MGMT_API_URL` is reachable from the control-plane pod.

### Rotation returns 409 (persistence not configured)

`ZITADEL_MGMT_SECRET_NAME` is not set on the fleet-manager deployment. Set the Helm value
`fleetManager.zitadel.existingSecret` (pointing at the Secret holding the SA key JSON)
and re-run the fleet deploy (`apps/fleet-platform/deploy.sh`) before retrying.

### Key was revoked before rotation completed

If the old key was revoked and the rotation failed (or was not started), the control
plane loses the ability to manage Zitadel. Restore access by:

1. Creating a new SA key in Zitadel for the service account.
2. Updating the `ZITADEL_MGMT_SA_KEY` env (the Kubernetes Secret pointed at by `fleetManager.zitadel.existingSecret`) directly with the new key JSON.
3. Restarting the fleet-manager pod so it reads the new key from env on boot:
   ```bash
   kubectl rollout restart deployment/opencrane-fleet-manager -n opencrane-system
   ```
4. Then running `oc admin zitadel rotate-key` normally to register the key in
   persistence, ready for the next rotation.
