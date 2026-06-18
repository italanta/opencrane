import type { Command } from "commander";

import type { ProviderCredentialWrite } from "@opencrane/contracts";

import type { CliConfig } from "../config.js";
import { _MakeClient } from "../config.js";
import { _Print, _PrintApiError, _PrintSuccess, type OutputFormat } from "../format.js";

// NOTE: This command only ever sends `--secret-ref` (the name of the
// External-Secrets-synced k8s Secret holding the provider key); it never sends a
// raw key. Uploading a raw key to GCP Secret Manager via a `--token-file` flag is
// a deliberate future enhancement, not part of this slice.

/** Columns shown for `oc credential list` in table mode. */
const _LIST_COLUMNS = ["id", "scope", "clusterTenant", "provider", "secretRef", "litellmCredentialName"];

/** Flag values for `oc credential list`. */
interface _CredentialListOptions
{
  /** Filter to a single ClusterTenant's credentials. */
  clusterTenant?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc credential add`. */
interface _CredentialAddOptions
{
  /** Free-text provider key, e.g. openai. */
  provider: string;
  /** Name of the External-Secrets-synced k8s Secret carrying the provider key. */
  secretRef: string;
  /** Scope: global | clusterTenant (defaults to global server-side). */
  scope?: string;
  /** Owning ClusterTenant when scope is clusterTenant. */
  clusterTenant?: string;
  /** Optional LiteLLM /credentials name for the dynamic no-restart path. */
  litellmCredentialName?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Flag values for `oc credential update`. */
interface _CredentialUpdateOptions
{
  /** New k8s Secret name carrying the provider key. */
  secretRef?: string;
  /** New LiteLLM /credentials name. */
  litellmCredentialName?: string;
  /** Output format. */
  output: OutputFormat;
}

/** Register all `oc credential *` sub-commands on the given parent Command. */
export function _RegisterCredential(parent: Command, getConfig: () => CliConfig): void
{
  const credential = parent
    .command("credential")
    .description("Manage provider credentials — references to External-Secrets-synced keys (list, show, add, update, remove)");

  credential
    .command("list")
    .description("List provider credentials (references only — never the key value)")
    .option("--cluster-tenant <id>", "Filter to one cluster tenant's credentials")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _list(opts: _CredentialListOptions)
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/providers/credentials", {
        params: { query: opts.clusterTenant ? { clusterTenant: opts.clusterTenant } : {} },
      });
      if (error) _PrintApiError("credential list", error);
      _Print(data, opts.output, _LIST_COLUMNS);
    });

  credential
    .command("show <id>")
    .description("Show a single provider credential by id")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _show(id: string, opts: { output: OutputFormat })
    {
      const client = _MakeClient(getConfig());
      const { data, error } = await client.GET("/providers/credentials/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("credential show", error);
      _Print(data, opts.output);
    });

  credential
    .command("add")
    .description("Register a provider credential reference (never sends a raw key)")
    .requiredOption("--provider <name>", "Provider key, e.g. openai, anthropic")
    .requiredOption("--secret-ref <k8sSecretName>", "Name of the External-Secrets-synced k8s Secret holding the key")
    .option("--scope <scope>", "Scope: global|clusterTenant")
    .option("--cluster-tenant <id>", "Owning cluster tenant (required when --scope clusterTenant)")
    .option("--litellm-credential-name <name>", "LiteLLM /credentials name for the dynamic no-restart path")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _add(opts: _CredentialAddOptions)
    {
      // 1. Assemble the typed write body from the supplied flags. The scope
      //    string is passed through so the API stays the single validator.
      const body: ProviderCredentialWrite = {
        provider: opts.provider,
        secretRef: opts.secretRef,
        ...(opts.scope ? { scope: opts.scope as ProviderCredentialWrite["scope"] } : {}),
        ...(opts.clusterTenant ? { clusterTenant: opts.clusterTenant } : {}),
        ...(opts.litellmCredentialName ? { litellmCredentialName: opts.litellmCredentialName } : {}),
      };

      // 2. POST through the generated client — just another API client.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.POST("/providers/credentials", { body });
      if (error) _PrintApiError("credential add", error);
      _Print(data, opts.output);
    });

  credential
    .command("update <id>")
    .description("Update a provider credential reference (only the supplied fields change)")
    .option("--secret-ref <k8sSecretName>", "New name of the External-Secrets-synced k8s Secret holding the key")
    .option("--litellm-credential-name <name>", "New LiteLLM /credentials name")
    .option("-o, --output <format>", "Output format: table|json", "table")
    .action(async function _update(id: string, opts: _CredentialUpdateOptions)
    {
      // 1. Build a partial body: only flags the caller passed are sent.
      const body: Partial<ProviderCredentialWrite> = {
        ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
        ...(opts.litellmCredentialName ? { litellmCredentialName: opts.litellmCredentialName } : {}),
      };

      // 2. PUT through the generated client; server-side validation owns the rules.
      const client = _MakeClient(getConfig());
      const { data, error } = await client.PUT("/providers/credentials/{id}", {
        params: { path: { id } },
        body: body as ProviderCredentialWrite,
      });
      if (error) _PrintApiError("credential update", error);
      _Print(data, opts.output);
    });

  credential
    .command("remove <id>")
    .description("Delete a provider credential")
    .action(async function _remove(id: string)
    {
      const client = _MakeClient(getConfig());
      const { error } = await client.DELETE("/providers/credentials/{id}", { params: { path: { id } } });
      if (error) _PrintApiError("credential remove", error);
      _PrintSuccess(`Provider credential "${id}" removed`);
    });
}
