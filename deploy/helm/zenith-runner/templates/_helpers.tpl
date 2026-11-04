{{/*
Names, labels and small helpers shared by the templates.
*/}}
{{- define "zenith-runner.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "zenith-runner.fullname" -}}
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

{{- define "zenith-runner.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "zenith-runner.selectorLabels" -}}
app.kubernetes.io/name: {{ include "zenith-runner.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "zenith-runner.labels" -}}
helm.sh/chart: {{ include "zenith-runner.chart" . }}
{{ include "zenith-runner.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "zenith-runner.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "zenith-runner.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "zenith-runner.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "zenith-runner.pvcName" -}}
{{- default (printf "%s-state" (include "zenith-runner.fullname" .)) .Values.persistence.existingClaim -}}
{{- end -}}

{{/*
The runner configuration file, rendered as JSON (valid input for the runner,
and immune to YAML quoting surprises). Chart-managed settings (control plane
URL, state directory, pinned CA path, agent name) override anything in
.Values.config.
*/}}
{{- define "zenith-runner.config" -}}
{{- $cfg := deepCopy .Values.config -}}
{{- $_ := set $cfg "controlPlane" (dict "url" (required "controlPlane.url is required (https://your-zenith-host)" .Values.controlPlane.url)) -}}
{{- $_ := set $cfg "stateDir" "/var/lib/zenith-runner" -}}
{{- if not $cfg.name -}}
{{- $_ := set $cfg "name" (include "zenith-runner.fullname" .) -}}
{{- end -}}
{{- if .Values.tls.ca.existingSecret -}}
{{- $_ := set $cfg "tls" (dict "caFile" "/etc/zenith-runner/ca/ca.crt") -}}
{{- end -}}
{{- toPrettyJson $cfg -}}
{{- end -}}
