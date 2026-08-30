"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  Chip,
  CostDelta,
  Field,
  Input,
  Select,
  Switch,
  Tabs,
} from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { SIZE_SPECS, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import { bindingEnv } from "@/lib/domain/graph";
import type {
  Binding,
  Manifest,
  Resource,
  Route,
  Service,
  ServiceSize,
} from "@/lib/domain/types";
import { cx, fmtUsd } from "@/lib/format";

/* ------------------------------ shared pieces ------------------------------ */

const SIZES: ServiceSize[] = ["nano", "small", "standard", "performance"];

const sizeOptions = SIZES.map((s) => ({
  value: s,
  label: `${s} — ${SIZE_SPECS[s].vcpu} vCPU · ${SIZE_SPECS[s].memoryMb} MB`,
}));

/** Cost-affecting defaults are always visible, never buried. */
function SizeField({
  value,
  onChange,
  monthlyUsd,
}: {
  value: ServiceSize;
  onChange: (v: ServiceSize) => void;
  monthlyUsd?: number;
}) {
  return (
    <Field
      label="Size"
      hint={monthlyUsd === undefined ? undefined : `${fmtUsd(monthlyUsd)}/mo est.`}
      help={`${SIZE_SPECS[value].vcpu} vCPU · ${SIZE_SPECS[value].memoryMb} MB per replica.`}
    >
      <Select
        options={sizeOptions}
        value={value}
        onChange={(e) => onChange(e.target.value as ServiceSize)}
      />
    </Field>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-line rounded-card border border-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <dt className="text-[12px] tracking-[0.02em] text-ink-faint uppercase">{k}</dt>
          <dd className="tnum min-w-0 truncate text-right text-[12.5px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[12px] font-medium tracking-[0.04em] text-ink-faint uppercase">
      {children}
    </h3>
  );
}

/* -------------------------------- bindings -------------------------------- */

function BindingList({ nodeId }: { nodeId: string }) {
  const { project } = useProjectData();
  const m = project.workingManifest;
  const related = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);

  const label = (id: string) =>
    m.services.find((s) => s.id === id)?.name ??
    m.resources.find((r) => r.id === id)?.name ??
    m.routes.find((r) => r.id === id)?.host ??
    id;

  if (related.length === 0)
    return (
      <p className="text-[13px] text-ink-mute">
        Nothing is connected here yet. Use <strong className="font-medium text-ink">Connect</strong>{" "}
        on the map toolbar to draw a connection, and Orrery injects the configuration for you.
      </p>
    );

  return (
    <div className="space-y-2.5">
      {related.map((b: Binding) => {
        const outgoing = b.from === nodeId;
        const injected = bindingEnv(m, b);
        return (
          <div key={b.id} className="space-y-2 rounded-card border border-line bg-bg1 p-3">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span className={cx("truncate", !outgoing && "text-ink-mute")}>
                {label(b.from)}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
              <span className={cx("truncate", outgoing && "text-ink")}>{label(b.to)}</span>
              <Chip className="ml-auto">{b.capability}</Chip>
            </div>
            {b.note && <p className="text-[12.5px] text-ink-mute">{b.note}</p>}
            {outgoing && injected.length > 0 && (
              <p className="font-mono text-[11.5px] text-ink-faint">
                injects {injected.map((e) => e.key).join(", ")}
              </p>
            )}
            <PlanFirst
              actionId="system.unbind"
              input={{ bindingId: b.id }}
              label="Disconnect"
              variant="quiet"
            />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ env & secrets ------------------------------ */

function EnvPanel({ service }: { service: Service }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionTitle>Set on {service.name}</SectionTitle>
        {service.env.length === 0 ? (
          <p className="text-[13px] text-ink-mute">
            No variables of its own yet. Anything this service is connected to already injects its
            own configuration — see the Connections tab.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line">
            {service.env.map((e) => (
              <li key={e.key} className="group space-y-1.5 px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[12px] text-ink">{e.key}</span>
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-ink-mute">
                    {e.secretRef ? (
                      <span title={`Stored as a secret (${e.secretRef}); the value is never read back.`}>
                        •••••••• <span className="text-ink-faint">secret</span>
                      </span>
                    ) : (
                      e.value
                    )}
                  </span>
                </div>
                <div className="opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 focus-within:opacity-100">
                  <PlanFirst
                    actionId="system.setEnvVar"
                    input={{ serviceId: service.id, key: e.key, value: null }}
                    label="Remove"
                    variant="ghost"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <SectionTitle>Add a variable</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Key">
            <Input value={key} mono onChange={(e) => setKey(e.target.value)} placeholder="LOG_LEVEL" />
          </Field>
          <Field label="Value">
            <Input value={value} mono onChange={(e) => setValue(e.target.value)} placeholder="info" />
          </Field>
        </div>
        <PlanFirst
          actionId="system.setEnvVar"
          input={{ serviceId: service.id, key: key.trim(), value }}
          label="Add variable"
          disabled={!key.trim()}
          disabledReason="Give the variable a name first."
          onDone={() => {
            setKey("");
            setValue("");
          }}
        />
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <SectionTitle>Add a secret</SectionTitle>
        <p className="text-[12.5px] text-ink-mute">
          The manifest records only a reference. The value never lands in the diff, the audit log or
          an export bundle — and it is never shown again after you save it.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Key">
            <Input
              value={secretKey}
              mono
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder="STRIPE_API_KEY"
            />
          </Field>
          <Field label="Value">
            <Input
              type="password"
              value={secretValue}
              mono
              autoComplete="off"
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder="sk_live_…"
            />
          </Field>
        </div>
        <PlanFirst
          actionId="system.setSecret"
          input={{ serviceId: service.id, key: secretKey.trim(), secretValue }}
          label="Store secret"
          disabled={!secretKey.trim()}
          disabledReason="Give the secret a name first."
          onDone={() => {
            setSecretKey("");
            setSecretValue("");
          }}
        />
      </div>
    </div>
  );
}

/* -------------------------------- services -------------------------------- */

interface ServiceDraft {
  name: string;
  kind: Service["kind"];
  size: ServiceSize;
  replicas: string;
  port: string;
  healthPath: string;
  schedule: string;
  sourceMode: "image" | "repo";
  image: string;
  repo: string;
  ref: string;
}

const serviceDraft = (s: Service): ServiceDraft => ({
  name: s.name,
  kind: s.kind,
  size: s.size,
  replicas: String(s.replicas),
  port: s.port ? String(s.port) : "",
  healthPath: s.healthPath ?? "",
  schedule: s.schedule ?? "",
  sourceMode: s.source.type === "git" ? "repo" : "image",
  image: s.source.type === "image" ? s.source.image : "",
  repo: s.source.type === "git" ? s.source.repo : "",
  ref: s.source.type === "git" ? s.source.ref : "main",
});

function serviceUpdateInput(s: Service, d: ServiceDraft): Record<string, unknown> {
  const input: Record<string, unknown> = { serviceId: s.id };
  if (d.name !== s.name) input.name = d.name.trim();
  if (d.kind !== s.kind) input.kind = d.kind;
  if (d.size !== s.size) input.size = d.size;
  if (Number(d.replicas) !== s.replicas) input.replicas = Number(d.replicas);
  if (d.port && Number(d.port) !== s.port) input.port = Number(d.port);
  if (d.healthPath !== (s.healthPath ?? "")) input.healthPath = d.healthPath;
  if (d.schedule !== (s.schedule ?? "")) input.schedule = d.schedule;
  if (d.sourceMode === "image" && d.image && !(s.source.type === "image" && s.source.image === d.image))
    input.image = d.image.trim();
  if (d.sourceMode === "repo" && d.repo) {
    const same = s.source.type === "git" && s.source.repo === d.repo && s.source.ref === d.ref;
    if (!same) {
      input.repo = d.repo.trim();
      input.ref = d.ref.trim() || "main";
    }
  }
  return input;
}

const KIND_OPTIONS = [
  { value: "web", label: "web — serves HTTP" },
  { value: "worker", label: "worker — long-running background process" },
  { value: "cron", label: "cron — runs on a schedule" },
  { value: "static", label: "static — prebuilt files" },
];

export function ServiceEditor({ service }: { service: Service }) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");
  const [draft, setDraft] = useState<ServiceDraft>(() => serviceDraft(service));

  useEffect(() => setDraft(serviceDraft(service)), [service.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof ServiceDraft>(k: K, v: ServiceDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const input = serviceUpdateInput(service, draft);
  const dirty = Object.keys(input).length > 1;

  const { current, projected } = useMemo(() => {
    const m: Manifest = structuredClone(project.workingManifest);
    const s = m.services.find((x) => x.id === service.id);
    const before = nodeMonthlyCostUsd(m, service.id);
    if (s) {
      s.size = draft.size;
      s.kind = draft.kind;
      s.replicas = Number.isFinite(Number(draft.replicas)) ? Number(draft.replicas) : s.replicas;
    }
    return { current: before, projected: nodeMonthlyCostUsd(m, service.id) };
  }, [project.workingManifest, service.id, draft.size, draft.kind, draft.replicas]);

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
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-4">
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

          <SizeField value={draft.size} onChange={(v) => set("size", v)} monthlyUsd={projected} />

          {draft.kind !== "cron" && draft.kind !== "static" && (
            <Field
              label="Replicas"
              help="How many copies run. 0 stops serving traffic."
              hint={<CostDelta usd={projected - current} />}
            >
              <Input
                type="number"
                min={0}
                max={10}
                value={draft.replicas}
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

          <PlanFirst
            actionId="system.updateService"
            input={input}
            label="Apply change"
            disabled={!dirty}
            disabledReason="Change a field first — there is nothing to apply yet."
            onCancel={dirty ? () => setDraft(serviceDraft(service)) : undefined}
          />
        </div>
      )}

      {tab === "env" && <EnvPanel service={service} />}
      {tab === "bindings" && <BindingList nodeId={service.id} />}

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
          />
        </div>
      )}
    </div>
  );
}

/* -------------------------------- resources -------------------------------- */

const STATEFUL_KINDS = ["postgres", "redis", "object_store", "queue"];

export function ResourceEditor({ resource }: { resource: Resource }) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");
  const [name, setName] = useState(resource.name);
  const [size, setSize] = useState<ServiceSize>(resource.size);

  useEffect(() => {
    setName(resource.name);
    setSize(resource.size);
  }, [resource.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const managed = resource.ownership === "managed";
  const { current, projected } = useMemo(() => {
    const m: Manifest = structuredClone(project.workingManifest);
    const r = m.resources.find((x) => x.id === resource.id);
    const before = nodeMonthlyCostUsd(m, resource.id);
    if (r) r.size = size;
    return { current: before, projected: nodeMonthlyCostUsd(m, resource.id) };
  }, [project.workingManifest, resource.id, size]);

  const input: Record<string, unknown> = { resourceId: resource.id };
  if (name !== resource.name) input.name = name.trim();
  if (size !== resource.size) input.size = size;
  const dirty = Object.keys(input).length > 1;

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "config", label: "Config" },
          {
            value: "bindings",
            label: "Connections",
            badge:
              project.workingManifest.bindings.filter(
                (b) => b.from === resource.id || b.to === resource.id
              ).length || undefined,
          },
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-4">
          {!managed && (
            <p className="rounded-ctl border border-line bg-bg1 p-2.5 text-[12.5px] text-ink-mute">
              This {resource.kind} is <strong className="text-ink">{resource.ownership}</strong>:
              Orrery reads it and connects to it, but never provisions, resizes or deletes it — and
              it is not part of the cost estimate.
            </p>
          )}
          <Field label="Name" help="Renaming changes the env vars injected into everything bound to it.">
            <Input value={name} mono onChange={(e) => setName(e.target.value)} />
          </Field>
          <SizeField
            value={size}
            onChange={setSize}
            monthlyUsd={managed ? projected : undefined}
          />
          {managed && size !== resource.size && (
            <p className="text-[12.5px] text-ink-mute">
              est. cost change <CostDelta usd={projected - current} />
            </p>
          )}
          <Facts
            rows={[
              ["Kind", resource.kind],
              ["Ownership", resource.ownership],
              ...(resource.externalRef
                ? ([["External ref", <span key="x" className="font-mono">{resource.externalRef}</span>]] as [
                    string,
                    React.ReactNode,
                  ][])
                : []),
            ]}
          />
          <PlanFirst
            actionId="system.updateResource"
            input={input}
            label="Apply change"
            disabled={!dirty}
            disabledReason="Change a field first — there is nothing to apply yet."
            onCancel={
              dirty
                ? () => {
                    setName(resource.name);
                    setSize(resource.size);
                  }
                : undefined
            }
          />
        </div>
      )}

      {tab === "bindings" && <BindingList nodeId={resource.id} />}

      {tab === "danger" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-mute">
            {STATEFUL_KINDS.includes(resource.kind) && managed
              ? `Deploying this removal destroys the data in ${resource.name}. Rollback restores the system definition, not the data.`
              : `Removing ${resource.name} takes it out of the working system. Nothing changes in a running environment until you deploy.`}
          </p>
          <PlanFirst
            actionId="system.removeResource"
            input={{ resourceId: resource.id }}
            label={`Remove ${resource.name}`}
            variant="danger"
            confirmName={
              STATEFUL_KINDS.includes(resource.kind) && managed ? resource.name : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

/* --------------------------------- routes ---------------------------------- */

export function RouteEditor({ route }: { route: Route }) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "config", label: "Details" },
          {
            value: "bindings",
            label: "Connections",
            badge:
              project.workingManifest.bindings.filter((b) => b.from === route.id).length ||
              undefined,
          },
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-3">
          <Facts
            rows={[
              ["Host", <span key="h" className="font-mono">{route.host}</span>],
              ["Path prefix", <span key="p" className="font-mono">{route.pathPrefix}</span>],
              ["TLS", route.tls ? "on — certificate managed" : "off"],
              ["DNS", route.managedDns ? "Orrery-managed hostname" : "your own hostname (CNAME)"],
            ]}
          />
          <p className="text-[12.5px] text-ink-mute">
            A hostname is an identity, not a setting — to change it, publish a new route and remove
            this one, so the old address keeps working until you say otherwise.
          </p>
        </div>
      )}

      {tab === "bindings" && <BindingList nodeId={route.id} />}

      {tab === "danger" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-mute">
            {route.host} stops resolving once this is deployed. Anything pointing at it breaks.
          </p>
          <PlanFirst
            actionId="system.removeRoute"
            input={{ routeId: route.id }}
            label={`Unpublish ${route.host}`}
            variant="danger"
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ creation forms ----------------------------- */

export function AddServiceForm({ onCreated }: { onCreated: (nodeId: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Service["kind"]>("web");
  const [sourceMode, setSourceMode] = useState<"image" | "repo">("image");
  const [image, setImage] = useState("");
  const [repo, setRepo] = useState("");
  const [size, setSize] = useState<ServiceSize>("small");
  const [replicas, setReplicas] = useState("1");
  const [port, setPort] = useState("3000");
  const [schedule, setSchedule] = useState("0 * * * *");

  const input: Record<string, unknown> = { name: name.trim(), kind, size };
  if (sourceMode === "image" && image.trim()) input.image = image.trim();
  if (sourceMode === "repo" && repo.trim()) input.repo = repo.trim();
  if (kind !== "cron" && kind !== "static") input.replicas = Number(replicas) || 0;
  if (kind === "web" && port) input.port = Number(port);
  if (kind === "cron") input.schedule = schedule;

  return (
    <div className="space-y-4">
      <Field label="Name" required help="Lowercase letters, digits and dashes.">
        <Input value={name} mono autoFocus placeholder="api" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Kind">
        <Select
          options={KIND_OPTIONS}
          value={kind}
          onChange={(e) => setKind(e.target.value as Service["kind"])}
        />
      </Field>
      <Field label="Source" help="Leave the image blank to start from the Orrery sample image.">
        <Select
          options={[
            { value: "image", label: "Container image" },
            { value: "repo", label: "Git repository" },
          ]}
          value={sourceMode}
          onChange={(e) => setSourceMode(e.target.value as "image" | "repo")}
        />
      </Field>
      {sourceMode === "image" ? (
        <Field label="Image">
          <Input
            value={image}
            mono
            placeholder="ghcr.io/acme/api:1.4.0"
            onChange={(e) => setImage(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Repository">
          <Input
            value={repo}
            mono
            placeholder="github.com/acme/api"
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>
      )}
      <SizeField value={size} onChange={setSize} />
      {kind !== "cron" && kind !== "static" && (
        <Field label="Replicas">
          <Input
            type="number"
            min={0}
            max={10}
            value={replicas}
            onChange={(e) => setReplicas(e.target.value)}
          />
        </Field>
      )}
      {kind === "web" && (
        <Field label="Port" help="A wrong port fails the health check at deploy time.">
          <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
      )}
      {kind === "cron" && (
        <Field label="Schedule">
          <Input value={schedule} mono onChange={(e) => setSchedule(e.target.value)} />
        </Field>
      )}
      <PlanFirst
        actionId="system.addService"
        input={input}
        label="Add service"
        disabled={!name.trim()}
        disabledReason="Give the service a name first."
        onDone={(r) => {
          const id = (r.data as { serviceId?: string } | undefined)?.serviceId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}

const RESOURCE_OPTIONS = [
  { value: "postgres", label: "PostgreSQL — relational database" },
  { value: "redis", label: "Redis — cache and ephemeral state" },
  { value: "object_store", label: "Object store — files and blobs" },
  { value: "queue", label: "Queue — work between services" },
  { value: "email", label: "Email — transactional sending" },
];

export function AddResourceForm({ onCreated }: { onCreated: (nodeId: string) => void }) {
  const { project } = useProjectData();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Resource["kind"]>("postgres");
  const [size, setSize] = useState<ServiceSize>("small");
  const [bindTo, setBindTo] = useState("");

  const input: Record<string, unknown> = { name: name.trim(), kind, size };
  if (bindTo) input.bindTo = bindTo;

  return (
    <div className="space-y-4">
      <Field label="Name" required help="Lowercase letters, digits and dashes.">
        <Input
          value={name}
          mono
          autoFocus
          placeholder="postgres"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Kind">
        <Select
          options={RESOURCE_OPTIONS}
          value={kind}
          onChange={(e) => setKind(e.target.value as Resource["kind"])}
        />
      </Field>
      <SizeField value={size} onChange={setSize} />
      <Field
        label="Connect to"
        help="Optional — connecting now injects the configuration into that service straight away."
      >
        <Select
          placeholder="Nothing yet"
          value={bindTo}
          onChange={(e) => setBindTo(e.target.value)}
          options={[
            { value: "", label: "Nothing yet" },
            ...project.workingManifest.services.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </Field>
      <PlanFirst
        actionId="system.addResource"
        input={input}
        label="Add resource"
        disabled={!name.trim()}
        disabledReason="Give the resource a name first."
        onDone={(r) => {
          const id = (r.data as { resourceId?: string } | undefined)?.resourceId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}

export function AddRouteForm({ onCreated }: { onCreated: (nodeId: string) => void }) {
  const { project } = useProjectData();
  const [host, setHost] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [tls, setTls] = useState(true);

  const servable = project.workingManifest.services.filter(
    (s) => s.kind === "web" || s.kind === "static"
  );

  const input: Record<string, unknown> = { tls };
  if (host.trim()) input.host = host.trim();
  if (serviceId) input.serviceId = serviceId;

  return (
    <div className="space-y-4">
      <Field
        label="Hostname"
        help={
          host.trim()
            ? "Your own hostname: point a CNAME at the environment before deploying."
            : "Leave blank for an Orrery-managed hostname with DNS and TLS handled for you."
        }
      >
        <Input
          value={host}
          mono
          autoFocus
          placeholder={`app.${project.slug}.orrery.app`}
          onChange={(e) => setHost(e.target.value)}
        />
      </Field>
      <Field
        label="Serves"
        help={
          servable.length === 0
            ? "Add a web or static service first — only those can answer HTTP."
            : "Public traffic on this hostname reaches the service you pick."
        }
      >
        <Select
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          options={[
            { value: "", label: "Nothing yet (the route will 404)" },
            ...servable.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </Field>
      <div className="flex items-center justify-between gap-3 rounded-ctl border border-line px-3 py-2">
        <span className="text-[13px] text-ink">TLS</span>
        <Switch checked={tls} onChange={setTls} label="Serve over HTTPS" />
      </div>
      <PlanFirst
        actionId="system.addRoute"
        input={input}
        label="Publish route"
        onDone={(r) => {
          const id = (r.data as { routeId?: string } | undefined)?.routeId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}
