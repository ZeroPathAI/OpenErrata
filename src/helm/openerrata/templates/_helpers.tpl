{{- define "openerrata.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openerrata.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openerrata.labels" -}}
app.kubernetes.io/name: {{ include "openerrata.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "openerrata.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openerrata.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "openerrata.image" -}}
{{- if .Values.image.digest -}}
{{ printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end -}}
{{- end -}}

{{- define "openerrata.secretName" -}}
{{- if .Values.secrets.existingSecretName -}}
{{- .Values.secrets.existingSecretName -}}
{{- else -}}
{{- include "openerrata.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "openerrata.serviceAccountName" -}}
{{- $root := index . "root" -}}
{{- $component := index . "component" -}}
{{- $configuredName := index $root.Values.serviceAccount.names $component -}}
{{- if $configuredName -}}
{{- $configuredName -}}
{{- else -}}
{{- if not $root.Values.serviceAccount.create -}}
{{- fail (printf "serviceAccount.names.%s must be set when serviceAccount.create is false" $component) -}}
{{- end -}}
{{- printf "%s-%s" (include "openerrata.fullname" $root) $component -}}
{{- end -}}
{{- end -}}
