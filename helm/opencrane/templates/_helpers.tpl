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
