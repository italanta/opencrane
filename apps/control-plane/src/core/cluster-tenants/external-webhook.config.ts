import type { ExternalWebhookProvisionerConfig } from "./external-webhook.provisioner.types.js";

/**
 * Read external-webhook provisioner settings from the environment.
 *
 * @returns A config when both URL and token are set; otherwise null (no external
 *   backend — `dedicatedCluster` stays unavailable).
 */
export function _ReadExternalWebhookConfig(): ExternalWebhookProvisionerConfig | null
{
  // 1. Read the operator-supplied endpoint + token; absence simply means no
  //    external backend, so `dedicatedCluster` stays unavailable (fail-closed).
  const url = process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL?.trim();
  const token = process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN?.trim();
  if (!url || !token)
  {
    return null;
  }

  // 2. Refuse a non-HTTPS endpoint: the bearer token would otherwise be sent in
  //    plaintext. Fail loud at config load rather than leak the credential — the
  //    operator must fix the URL before the control plane will serve this tier.
  if (!url.startsWith("https://"))
  {
    throw new Error(
      "CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL must use https:// — refusing to send the provisioner bearer token over plaintext",
    );
  }

  // 3. Build the config with a stable provisioner id for capability routing.
  return { url, token, id: process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_ID?.trim() || "external" };
}
