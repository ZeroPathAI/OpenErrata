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
{{ printf "%s:%s" .Values.image.repository (required "image.tag or image.digest is required (e.g. main-latest)" .Values.image.tag) }}
{{- end -}}
{{- end -}}

{{- define "openerrata.frontendImage" -}}
{{- if .Values.frontend.image.digest -}}
{{ printf "%s@%s" .Values.frontend.image.repository .Values.frontend.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.frontend.image.repository (required "frontend.image.tag or frontend.image.digest is required (e.g. main-latest)" .Values.frontend.image.tag) }}
{{- end -}}
{{- end -}}

{{/*
Pod-template annotations that change whenever the rendered config or secret
changes, so `envFrom` consumers restart on config-only deploys.
*/}}
{{- define "openerrata.configChecksums" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if not .Values.secrets.existingSecretName }}
checksum/secret: {{ include (print .Template.BasePath "/secrets.yaml") . | sha256sum }}
{{- end }}
{{- end -}}

{{- define "openerrata.databaseUrlEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "openerrata.secretName" . }}
      key: DATABASE_URL
# Prisma CLI update checks are telemetry; never phone home from the cluster.
- name: CHECKPOINT_DISABLE
  value: "1"
{{- end -}}

{{/*
Init container for every workload that talks to the database. Pulumi deploys
this chart without Helm hook ordering, so the migrate Job runs alongside the
rollout; this holds new pods until every migration shipped in the image is
applied. `prisma migrate status` exits 0 once the database is up to date or
ahead of the image (e.g. after a rollback) and non-zero while migrations are
pending or failed.
*/}}
{{- define "openerrata.waitForMigrationsInitContainer" -}}
- name: wait-for-migrations
  image: {{ include "openerrata.image" . | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command:
    - sh
    - -c
    - 'until node node_modules/prisma/build/index.js migrate status; do echo "Waiting for database migrations"; sleep 5; done'
  env:
    {{- include "openerrata.databaseUrlEnv" . | nindent 4 }}
  securityContext:
    {{- toYaml .Values.containerSecurityContext | nindent 4 }}
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
