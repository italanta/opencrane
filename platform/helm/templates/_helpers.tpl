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
