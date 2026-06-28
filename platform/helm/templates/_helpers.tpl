{{/*
Expand the name of the chart.
*/}}
{{- define "opencrane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "opencrane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "opencrane.labels" -}}
helm.sh/chart: {{ include "opencrane.name" . }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: opencrane
{{- end }}

{{/*
Selector labels for a component
*/}}
{{- define "opencrane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opencrane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Resolve deployment environment for validation rules.
*/}}
{{- define "opencrane.environment" -}}
{{- default "dev" .Values.global.environment | lower -}}
{{- end }}

{{/*
Operator RBAC rules — shared by the cluster-scoped (legacy) and namespaced
(multi-instance) bindings so both grant identical verbs over identical resources.
All resources here are namespaced, so the same rule list is valid in a Role.
*/}}
{{- define "opencrane.fleetManagerRbacRules" -}}
# ClusterTenant CR — the fleet-manager's ONLY watch (Stage 5: it stops at ClusterTenant
# lifecycle and touches nothing inside a silo). The ClusterTenantOperator drives each org
# pending→ready and patches its status. Ungated: the operator always runs, independent of
# whether the management ROUTES (fleetManager.clusterTenantApi.enabled) are mounted.
- apiGroups: ["opencrane.io"]
  resources: ["clustertenants", "clustertenants/status"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Org isolation boundary: the reconciler creates the bound namespace `opencrane-<org>` with
# Pod Security Admission labels (and the ResourceQuota/LimitRange boundary). `namespaces` is
# CLUSTER-scoped, so this is only effective via the legacy ClusterRole; namespaced
# multi-instance mode cannot grant it and cluster-tenant provisioning requires the
# cluster-scoped operator. Without this the reconcile 403s on createNamespace.
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- if .Values.certManager.enabled }}
# Per-org wildcard TLS Certificates the ClusterTenant reconciler applies into each org's
# bound namespace (fixed-wildcard topology). Granted only when cert-manager is enabled;
# without it the reconciler skips the cert side effect at runtime anyway.
- apiGroups: ["cert-manager.io"]
  resources: ["certificates"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- end }}
{{- if .Values.externalDns.enabled }}
# Per-org DNSEndpoint CRs the ClusterTenant reconciler declares for external-dns. Granted
# only when external-dns is enabled; without it the reconciler skips the DNS side.
- apiGroups: ["externaldns.k8s.io"]
  resources: ["dnsendpoints"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- end }}
# Events for audit trail
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
{{- end }}

{{/*
Control-plane RBAC rules that target NAMESPACED resources only — shared by the
cluster-scoped (legacy) ClusterRole and the namespaced (multi-instance) Role so
both grant identical verbs over identical resources. The cluster-scoped
`clusterissuers` grant is deliberately NOT here: it cannot live in a namespaced
Role, so it stays in a minimal residual ClusterRole (see control-plane-rbac.yaml)
and is folded into the per-namespace Role by MI.4's namespaced cert Issuer.
*/}}
{{- define "opencrane.clustertenantManagerRbacRules" -}}
# Tenant + AccessPolicy CRDs — the control-plane API dual-writes them (alongside PostgreSQL)
# AND the in-silo TenantOperator/PolicyOperator (Stage 5) watch + reconcile them in this
# silo's own namespace.
- apiGroups: ["opencrane.io"]
  resources: ["tenants", "tenants/status", "accesspolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Per-tenant workloads the TenantOperator stamps into this namespace.
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["services", "configmaps", "persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Per-tenant ResourceQuota + LimitRange the TenantOperator stamps for its workloads.
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# ServiceAccounts for Workload Identity.
- apiGroups: [""]
  resources: ["serviceaccounts"]
  verbs: ["get", "list", "create", "update", "patch"]
# Mint short-lived, audience-bound tokens for a tenant's pod ServiceAccount via the
# TokenRequest subresource (POST /api/v1/auth/pod-token — SSO across the control plane and
# the tenant pod, see docs/auth.md).
- apiGroups: [""]
  resources: ["serviceaccounts/token"]
  verbs: ["create"]
# Secrets for tenant encryption keys + per-tenant LiteLLM keys.
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "update", "patch"]
# Pods: the idle-checker reads them, and the connection kill-switch (CONN.5) force-deletes by
# the `opencrane.io/tenant=<name>` label to sever live OpenClaw sockets (CNI-independent).
# No create/update — Deployments own pod creation.
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch", "delete", "deletecollection"]
# Per-tenant Ingress (serving) + NetworkPolicy (the S2 default-deny silo baseline + gateway).
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses", "networkpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Cilium policies (optional, if Cilium is installed).
- apiGroups: ["cilium.io"]
  resources: ["ciliumnetworkpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- if .Values.fleetManager.linkerdMeshEnabled }}
# Linkerd identity-layer policy CRs the silo reconcile applies per namespace (S5): a
# deny-by-default Server + MeshTLSAuthentication allow-list + the binding AuthorizationPolicy.
# Granted only when the mesh gate is on; an absent Linkerd CRD makes the apply skip.
- apiGroups: ["policy.linkerd.io"]
  resources: ["servers", "meshtlsauthentications", "authorizationpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
{{- end }}
# Events for audit trail.
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
{{- end }}

{{/*
Cognee endpoint the control-plane permission-sync routes call.

With the bundled Cognee on (`controlPlane.cognee.install`), Cognee is a release-local plane:
the Service is release-prefixed (`<fullname>-cognee`, B5) so two installs never collide on the
legacy unprefixed `cognee` singleton, and this helper points the control-plane at it. Otherwise
(BYO Cognee) the configured `controlPlane.cognee.endpoint` is used verbatim.
*/}}
{{- define "opencrane.cogneeEndpoint" -}}
{{- if .Values.clustertenantManager.cognee.install -}}
{{- printf "http://%s-cognee:%v" (include "opencrane.fullname" .) .Values.clustertenantManager.cognee.service.port -}}
{{- else -}}
{{- .Values.clustertenantManager.cognee.endpoint -}}
{{- end -}}
{{- end }}

{{/*
DATABASE_URL env entry for the control-plane (deployment initContainer, main container,
and the migration Job all share it so they can never drift).

Both roles wire the control-plane to the database the installer provisions via
`controlPlane.database.existingSecret` (or `.url`). Per-ClusterTenant isolation (S6 / ADR 0002)
comes from the SILO deploying a dedicated CNPG cluster IN ITS OWN NAMESPACE — one Postgres per
silo serving that silo's control-plane + runtime planes — so the silo control-plane's DB already
holds exactly one ClusterTenant's data and never has to infer which tenant a row belongs to. The
deploy scripts (`deploy-silo.sh` → `k8s-deploy.sh`) provision that per-namespace cluster + secret;
this helper just consumes whatever secret the installer points at, identically for both roles.

With no explicit DB this renders no DATABASE_URL (the control-plane stays in its no-DB mode); a
real deploy always supplies one.
*/}}
{{- define "opencrane.clustertenantManagerDatabaseEnv" -}}
{{- $db := .Values.clustertenantManager.database | default dict -}}
{{- if $db.existingSecret -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $db.existingSecret }}
      key: {{ $db.secretKey }}
{{- else if $db.url -}}
- name: DATABASE_URL
  value: {{ $db.url | quote }}
{{- end -}}
{{- end }}

{{/*
DATABASE_URL env entry for the fleet-manager (the cluster-wide singleton's registry DB).

The fleet-manager owns the global registry (ClusterTenant catalogue, billing, memberships) in its
OWN Postgres — distinct from each silo's per-CT DB. The installer points it at that DB via
`fleetManager.database.existingSecret` (or `.url`). With no explicit DB this renders no DATABASE_URL
(the registry is unreachable → /healthz reports degraded); a real fleet install always supplies one.
*/}}
{{- define "opencrane.fleetManagerDatabaseEnv" -}}
{{- $db := .Values.fleetManager.database | default dict -}}
{{- if $db.existingSecret -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $db.existingSecret }}
      key: {{ $db.secretKey }}
{{- else if $db.url -}}
- name: DATABASE_URL
  value: {{ $db.url | quote }}
{{- end -}}
{{- end }}

{{/*
Resolve the namespace(s) a multi-instance install owns for namespaced RBAC.
Defaults to the release namespace when `multiInstance.instanceNamespaces` is empty.
*/}}
{{- define "opencrane.instanceNamespaces" -}}
{{- $mi := .Values.multiInstance | default dict -}}
{{- $ns := $mi.instanceNamespaces | default (list) -}}
{{- if $ns -}}
{{- $ns | toJson -}}
{{- else -}}
{{- list .Release.Namespace | toJson -}}
{{- end -}}
{{- end }}

{{/*
Whether namespaced (per-instance) RBAC should be rendered instead of cluster-scoped.
*/}}
{{- define "opencrane.namespacedRbac" -}}
{{- $mi := .Values.multiInstance | default dict -}}
{{- and $mi.enabled (eq (default "namespaced" $mi.rbac) "namespaced") -}}
{{- end }}

{{/*
Whether a namespaced (per-instance) cert Issuer should be rendered instead of a
cluster-singleton ClusterIssuer (brief B4). Only true when multi-instance is on
AND `multiInstance.certIssuer` is `namespaced`; legacy installs stay ClusterIssuer.
*/}}
{{- define "opencrane.namespacedCertIssuer" -}}
{{- $mi := .Values.multiInstance | default dict -}}
{{- and $mi.enabled (eq (default "cluster" $mi.certIssuer) "namespaced") -}}
{{- end }}

{{/*
Whether a namespaced (per-instance) SecretStore should be rendered instead of a
cluster-singleton ClusterSecretStore (brief B4). Only true when multi-instance is
on AND `multiInstance.secretStore` is `namespaced`; legacy stays ClusterSecretStore.
*/}}
{{- define "opencrane.namespacedSecretStore" -}}
{{- $mi := .Values.multiInstance | default dict -}}
{{- and $mi.enabled (eq (default "cluster" $mi.secretStore) "namespaced") -}}
{{- end }}

{{/*
sharedPlatform scope resolution (multi-instance blocker B5).

`opencrane.<component>Shared` returns the literal string "true" when a component is
configured as `shared` (an external, centrally-operated endpoint serves all
instances), and "" (falsey) otherwise. Default for every component is `instance`, so
an absent or partial `sharedPlatform` block preserves today's release-local behaviour.

`opencrane.<component>Url` / `opencrane.obotSecretName` resolve the endpoint/name the
consumers should use:
  - instance mode → release-prefixed in-cluster name (current behaviour).
  - shared mode   → the externally-provided value, failing fast if it is unset.
*/}}

{{- define "opencrane.litellmShared" -}}
{{- $sp := .Values.sharedPlatform | default dict -}}
{{- $c := $sp.litellm | default dict -}}
{{- if eq (default "instance" $c.mode) "shared" -}}true{{- end -}}
{{- end }}

{{- define "opencrane.skillRegistryShared" -}}
{{- $sp := .Values.sharedPlatform | default dict -}}
{{- $c := $sp.skillRegistry | default dict -}}
{{- if eq (default "instance" $c.mode) "shared" -}}true{{- end -}}
{{- end }}

{{- define "opencrane.mcpGatewayShared" -}}
{{- $sp := .Values.sharedPlatform | default dict -}}
{{- $c := $sp.mcpGateway | default dict -}}
{{- if eq (default "instance" $c.mode) "shared" -}}true{{- end -}}
{{- end }}

{{- define "opencrane.externalSecretsShared" -}}
{{- $sp := .Values.sharedPlatform | default dict -}}
{{- $c := $sp.externalSecrets | default dict -}}
{{- if eq (default "instance" $c.mode) "shared" -}}true{{- end -}}
{{- end }}

{{/*
LiteLLM base endpoint the operator and control-plane should call.
instance → release-local Service; shared → sharedPlatform.litellm.shared.endpoint.
*/}}
{{- define "opencrane.litellmEndpoint" -}}
{{- if eq (include "opencrane.litellmShared" .) "true" -}}
{{- $ep := .Values.sharedPlatform.litellm.shared.endpoint | default "" -}}
{{- if not $ep -}}{{- fail "sharedPlatform.litellm.mode=shared requires sharedPlatform.litellm.shared.endpoint" -}}{{- end -}}
{{- $ep -}}
{{- else -}}
{{- printf "http://%s-litellm:%v" (include "opencrane.fullname" .) .Values.litellm.service.port -}}
{{- end -}}
{{- end }}

{{/*
Skill-registry base URL the operator injects into tenant runtimes.
instance → release-local Service; shared → sharedPlatform.skillRegistry.shared.url.
*/}}
{{- define "opencrane.skillRegistryUrl" -}}
{{- if eq (include "opencrane.skillRegistryShared" .) "true" -}}
{{- $u := .Values.sharedPlatform.skillRegistry.shared.url | default "" -}}
{{- if not $u -}}{{- fail "sharedPlatform.skillRegistry.mode=shared requires sharedPlatform.skillRegistry.shared.url" -}}{{- end -}}
{{- $u -}}
{{- else -}}
{{- printf "http://%s-skill-registry:%v" (include "opencrane.fullname" .) .Values.skillRegistry.service.port -}}
{{- end -}}
{{- end }}

{{/*
Obot MCP gateway base URL the operator injects into tenant runtimes.
instance → release-local Service; shared → sharedPlatform.mcpGateway.shared.url.
*/}}
{{- define "opencrane.mcpGatewayUrl" -}}
{{- if eq (include "opencrane.mcpGatewayShared" .) "true" -}}
{{- $u := .Values.sharedPlatform.mcpGateway.shared.url | default "" -}}
{{- if not $u -}}{{- fail "sharedPlatform.mcpGateway.mode=shared requires sharedPlatform.mcpGateway.shared.url" -}}{{- end -}}
{{- $u -}}
{{- else -}}
{{- printf "http://%s-mcp-gateway:%v" (include "opencrane.fullname" .) .Values.mcpGateway.service.port -}}
{{- end -}}
{{- end }}

{{/*
Name of the Secret holding Obot's PostgreSQL DSN (key `dsn`).
instance → release-prefixed `<fullname>-obot` (per-instance, collision-free; B5).
shared   → the operator points at an external Obot, so no in-release Secret is used.
This Secret is provisioned out-of-band (operator/installer), not by the chart.
*/}}
{{- define "opencrane.obotSecretName" -}}
{{- printf "%s-obot" (include "opencrane.fullname" .) -}}
{{- end }}

{{/*
Observability env block for an app container.

Call with a dict carrying the root context + the logical service name, e.g.:
  {{- include "opencrane.observabilityEnv" (dict "ctx" $ "component" "clustertenant-manager") | nindent 12 }}

NODE_ENV + LOG_LEVEL are always emitted so logs are consistent JSON. The OTEL_*
vars are emitted only when observability.otel.enabled, pointing apps at the
release-local collector Service; omitting them leaves @opencrane/observability's
startTelemetry a no-op (it keys off OTEL_EXPORTER_OTLP_ENDPOINT). The service name
is also set in code, so this stays correct even if the env var is dropped.
*/}}
{{- define "opencrane.observabilityEnv" -}}
{{- $ctx := .ctx -}}
{{- $component := .component -}}
{{- $o := $ctx.Values.observability | default dict -}}
{{- $otel := $o.otel | default dict -}}
{{- $collector := $otel.collector | default dict -}}
- name: NODE_ENV
  value: {{ default "production" $otel.nodeEnv | quote }}
- name: LOG_LEVEL
  value: {{ default "info" $otel.logLevel | quote }}
{{- if $otel.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://{{ include "opencrane.fullname" $ctx }}-otel-collector.{{ $ctx.Release.Namespace }}.svc:{{ default 4318 $collector.otlpPort }}"
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: "http/protobuf"
- name: OTEL_SERVICE_NAME
  value: {{ $component | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "service.namespace=opencrane,deployment.environment={{ include "opencrane.environment" $ctx }}"
{{- end }}
{{- end }}

{{/*
Validation guardrails for sensitive LiteLLM configuration.
*/}}
{{- define "opencrane.validate" -}}
{{- $env := include "opencrane.environment" . -}}
{{- if and .Values.litellm.enabled (not (or (eq $env "dev") (eq $env "development"))) -}}
	{{- $usingExistingSecret := not (empty .Values.litellm.existingSecret) -}}
	{{- $generateMasterKey := true -}}
	{{- if hasKey .Values.litellm "generateMasterKey" -}}
		{{- $generateMasterKey = .Values.litellm.generateMasterKey -}}
	{{- end -}}
	{{- $masterKey := default "" .Values.litellm.masterKey -}}
	{{- $placeholder := "change-me-in-production" -}}
	{{- if and (not $usingExistingSecret) (not $generateMasterKey) (or (empty $masterKey) (eq $masterKey $placeholder)) -}}
		{{- fail "LiteLLM is enabled in non-dev environment, but no secure master key is configured. Set litellm.existingSecret, set litellm.generateMasterKey=true, or provide a non-placeholder litellm.masterKey." -}}
	{{- end -}}
{{- end -}}
{{- end }}
