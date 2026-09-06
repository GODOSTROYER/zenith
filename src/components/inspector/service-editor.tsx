"use client";
/** One service: config, env, connections, day-two operations, removal. */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import { SectionTitle } from "@/components/screens/shared";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { BindingList } from "./binding-list";
import { EnvPanel } from "./env-panel";
import {
  CostHint,
  KIND_OPTIONS,
  SizeField,
  StaleNotice,
  serviceCost,
  useUpstreamGuard,
} from "./editor-parts";
import {
  serviceDraft,
  serviceEditIssues,
  serviceUpdateInput,
  type ServiceDraft,
} from "./logic";
import type { Service, ServiceSize } from "@/lib/domain/types";

/** Where this node is written about elsewhere. Never a dead end on the map. */
function NodeLinks({ nodeId, name }: { nodeId: string; name: string }) {
  const { project, findings } = useProjectData();
  const open = findings.filter((f) => f.targetId === nodeId && f.status === "open").length;
  const rows: { href: string; label: string; note: string }[] = [
    {
      href: `/p/${project.slug}/observe?service=${encodeURIComponent(nodeId)}`,
      label: "Logs and health",
      note: `Observe for this environment — pick ${name} in the service list.`,
    },
    {
      href: `/p/${project.slug}/deploys`,
      label: "Deploys",
      note: "Every deployment of this project, newest first.",
    },
    {
      href: `/p/${project.slug}/security`,
      label: open ? `Findings (${open} open)` : "Findings",
      note: open ? `${open} open finding${open === 1 ? "" : "s"} name ${name}.` : `Nothing open against ${name}.`,
    },
  ];
  return (
    <ul className="divide-y divide-line rounded-card border border-line">
      {rows.map((r) => (
        <li key={r.href}>
          <Link
            href={r.href}
            className="flex items-start gap-2 px-3 py-2.5 transition-colors duration-[120ms] hover:bg-bg2"
          >
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{r.label}</span>
              <span className="block text-[12px] text-ink-mute">{r.note}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Day two, on the node itself: restart what is running, scale what will run.
 * Scale is a manifest edit like everything else, so it says so — the same
 * number appears in the Changes panel until it is deployed.
 */
function OpsPanel({ service }: { service: Service }) {
  const { project, selectedEnv, selectedEnvId } = useProjectData();
  const deployed = Boolean(selectedEnv?.deployedRevisionId);
  const envName = selectedEnv?.name ?? "this environment";
  const [replicas, setReplicas] = useState(String(service.replicas));
  const [size, setSize] = useState<ServiceSize>(service.size);

  const scalable = service.kind !== "static";
  const nextReplicas = replicas.trim() === "" ? service.replicas : Number(replicas) || 0;
  const scaleInput: Record<string, unknown> = { serviceId: service.id };
  if (replicas.trim() !== "" && Number(replicas) !== service.replicas)
    scaleInput.replicas = Number(replicas);
  if (size !== service.size) scaleInput.size = size;
  const scaleDirty = Object.keys(scaleInput).length > 1;

  const { current, projected } = useMemo(
    () => serviceCost(project.workingManifest, service.id, { size, replicas: nextReplicas }),
    [project.workingManifest, service.id, size, nextReplicas]
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionTitle>Restart in {envName}</SectionTitle>
        <p className="text-[13px] text-ink-mute">
          {deployed
            ? `Replaces the running copies of ${service.name}. Nothing about the system definition changes — no revision, no deployment.`
            : `${envName} has never been deployed, so there is nothing running to restart.`}
        </p>
        <PlanFirst
          actionId="ops.restartService"
          input={{ serviceId: service.id }}
          scope={{ environmentId: selectedEnvId }}
          label={`Restart ${service.name}`}
          variant="quiet"
          disabled={!deployed}
          disabledReason={`${envName} has never been deployed. Deploy the system first, then restart it.`}
        />
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <SectionTitle>Scale</SectionTitle>
        <p className="text-[13px] text-ink-mute">
          Scaling edits the working copy, like every other change here — it takes effect on the next
          deploy to {envName}, not now.
        </p>
        <SizeField
          value={size}
          onChange={setSize}
          monthlyUsd={projected}
          deltaUsd={projected - current}
        />
        {scalable && (
          <Field
            label="Replicas"
            help="Leave it blank to keep the current count."
            hint={<CostHint monthlyUsd={projected} deltaUsd={projected - current} />}
          >
            <Input
              type="number"
              min={0}
              max={10}
              value={replicas}
              placeholder={String(service.replicas)}
              onChange={(e) => setReplicas(e.target.value)}
            />
          </Field>
        )}
        <PlanFirst
          actionId="ops.scaleService"
          input={scaleInput}
          label="Scale service"
          disabled={!scaleDirty}
          disabledReason="Pick a different size or replica count first."
          onCancel={
            scaleDirty
              ? () => {
                  setReplicas(String(service.replicas));
                  setSize(service.size);
                }
              : undefined
          }
        />
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <SectionTitle>Elsewhere</SectionTitle>
        <NodeLinks nodeId={service.id} name={service.name} />
      </div>
    </div>
  );
}

export interface ServiceEditorProps {
  service: Service;
  onOpenBinding?: (bindingId: string) => void;
}

export function ServiceEditor({ service, onOpenBinding }: ServiceEditorProps) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");
  const [draft, setDraft] = useState<ServiceDraft>(() => serviceDraft(service));

  const set = <K extends keyof ServiceDraft>(k: K, v: ServiceDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const input = serviceUpdateInput(service, draft);
  const dirty = Object.keys(input).length > 1;
  const issues = serviceEditIssues(service, draft);
  const guard = useUpstreamGuard(service, dirty, () => setDraft(serviceDraft(service)));

  const { current, projected } = useMemo(
    () =>
      serviceCost(project.workingManifest, service.id, {
        size: draft.size,
        kind: draft.kind,
        replicas: draft.replicas.trim() === "" ? service.replicas : Number(draft.replicas) || 0,
      }),
    [project.workingManifest, service.id, service.replicas, draft.size, draft.kind, draft.replicas]
  );

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "config", label: "Config" },
          { value: "env", label: "Env & secrets", badge: service.env.length || undefined },
          {
            value: "bindings",
            label: "Connections",
            badge:
              project.workingManifest.bindings.filter(
                (b) => b.from === service.id || b.to === service.id
              ).length || undefined,
          },
          { value: "ops", label: "Operations" },
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-4">
          {guard.stale && (
            <StaleNotice
              name={service.name}
              onReload={guard.reload}
              onKeepMine={guard.keepMine}
            />
          )}
          <Field label="Name" help="Lowercase letters, digits and dashes. Renaming changes injected env vars.">
            <Input value={draft.name} mono onChange={(e) => set("name", e.target.value)} />
          </Field>

          <Field label="Kind">
            <Select
              options={KIND_OPTIONS}
              value={draft.kind}
              onChange={(e) => set("kind", e.target.value as Service["kind"])}
            />
          </Field>

          <Field label="Source" help="Where the code that runs here comes from.">
            <Select
              options={[
                { value: "image", label: "Container image" },
                { value: "repo", label: "Git repository" },
              ]}
              value={draft.sourceMode}
              onChange={(e) => set("sourceMode", e.target.value as "image" | "repo")}
            />
          </Field>

          {draft.sourceMode === "image" ? (
            <Field label="Image">
              <Input
                value={draft.image}
                mono
                placeholder="ghcr.io/acme/api:1.4.0"
                onChange={(e) => set("image", e.target.value)}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-[1fr_100px] gap-2">
              <Field label="Repository">
                <Input
                  value={draft.repo}
                  mono
                  placeholder="github.com/acme/api"
                  onChange={(e) => set("repo", e.target.value)}
                />
              </Field>
              <Field label="Ref">
                <Input value={draft.ref} mono onChange={(e) => set("ref", e.target.value)} />
              </Field>
            </div>
          )}

          <SizeField
            value={draft.size}
            onChange={(v) => set("size", v)}
            monthlyUsd={projected}
            deltaUsd={projected - current}
          />

          {draft.kind !== "cron" && draft.kind !== "static" && (
            <Field
              label="Replicas"
              help="How many copies run. 0 stops serving traffic. Leave it blank to keep the current count."
              hint={<CostHint monthlyUsd={projected} deltaUsd={projected - current} />}
            >
              <Input
                type="number"
                min={0}
                max={10}
                value={draft.replicas}
                placeholder={String(service.replicas)}
                onChange={(e) => set("replicas", e.target.value)}
              />
            </Field>
          )}

          {(draft.kind === "web" || draft.kind === "worker") && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Port" help="The port your app listens on.">
                <Input
                  type="number"
                  value={draft.port}
                  onChange={(e) => set("port", e.target.value)}
                  placeholder="3000"
                />
              </Field>
              <Field label="Health path" help="Checked during verify.">
                <Input
                  value={draft.healthPath}
                  mono
                  placeholder="/healthz"
                  onChange={(e) => set("healthPath", e.target.value)}
                />
              </Field>
            </div>
          )}

          {draft.kind === "cron" && (
            <Field label="Schedule" help="Standard five-field cron expression.">
              <Input
                value={draft.schedule}
                mono
                placeholder="*/15 * * * *"
                onChange={(e) => set("schedule", e.target.value)}
              />
            </Field>
          )}

          {issues.length > 0 && (
            <Callout tone="warn">
              <ul className="space-y-1.5 text-[12.5px]">
                {issues.map((i) => (
                  <li key={i.field}>{i.reason}</li>
                ))}
              </ul>
            </Callout>
          )}

          <PlanFirst
            actionId="system.updateService"
            input={input}
            label="Apply change"
            disabled={!dirty || guard.stale || issues.length > 0}
            disabledReason={
              guard.stale
                ? `${service.name} changed underneath this form. Load the new values, or keep yours, before applying.`
                : issues.length > 0
                  ? issues.map((i) => i.reason).join(" ")
                  : "Change a field first — there is nothing to apply yet."
            }
            onCancel={dirty ? () => setDraft(serviceDraft(service)) : undefined}
          />
        </div>
      )}

      {tab === "env" && <EnvPanel service={service} />}
      {tab === "bindings" && <BindingList nodeId={service.id} onOpen={onOpenBinding} />}
      {tab === "ops" && <OpsPanel service={service} />}

      {tab === "danger" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-mute">
            Removing {service.name} takes it out of the working system. Nothing changes in a running
            environment until you deploy.
          </p>
          <PlanFirst
            actionId="system.removeService"
            input={{ serviceId: service.id }}
            label={`Remove ${service.name}`}
            variant="danger"
            confirmName={service.name}
            confirmWhen="high-risk"
          />
        </div>
      )}
    </div>
  );
}
