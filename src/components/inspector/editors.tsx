"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, ExternalLink, Pencil } from "lucide-react";
import {
  Button,
  Chip,
  CostDelta,
  CopyButton,
  Field,
  Input,
  Select,
  Switch,
  Tabs,
} from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import {
  serviceDraft,
  serviceEditIssues,
  serviceUpdateInput,
  type ServiceDraft,
} from "./logic";
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

/**
 * One hint shape for every cost-affecting field: what it costs, and — once you
 * have moved it — what that costs compared to now. Size used to read as an
 * absolute while replicas read as a delta, so the same money looked like two
 * different numbers on one screen.
 */
function CostHint({ monthlyUsd, deltaUsd }: { monthlyUsd?: number; deltaUsd?: number }) {
  if (monthlyUsd === undefined) return null;
  return (
    <>
      {fmtUsd(monthlyUsd)}/mo est.
      {deltaUsd !== undefined && deltaUsd !== 0 && (
        <>
          {" "}
          <CostDelta usd={deltaUsd} />
        </>
      )}
    </>
  );
}

/**
 * What a node costs now, and what the draft would cost. One node is rebuilt
 * shallowly — a structuredClone of the whole manifest on every keystroke was
 * doing deep work for a function that only reads three fields.
 */
function serviceCost(m: Manifest, id: string, patch: Partial<Service>) {
  const probe: Manifest = { ...m, services: m.services.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  return { current: nodeMonthlyCostUsd(m, id), projected: nodeMonthlyCostUsd(probe, id) };
}

function resourceCost(m: Manifest, id: string, patch: Partial<Resource>) {
  const probe: Manifest = { ...m, resources: m.resources.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
  return { current: nodeMonthlyCostUsd(m, id), projected: nodeMonthlyCostUsd(probe, id) };
}

/** Cost-affecting defaults are always visible, never buried. */
function SizeField({
  value,
  onChange,
  monthlyUsd,
  deltaUsd,
}: {
  value: ServiceSize;
  onChange: (v: ServiceSize) => void;
  monthlyUsd?: number;
  deltaUsd?: number;
}) {
  return (
    <Field
      label="Size"
      hint={<CostHint monthlyUsd={monthlyUsd} deltaUsd={deltaUsd} />}
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

/* ----------------------- editing against a moving target -------------------- */

/**
 * The project payload polls every 5 seconds, so a Navigator run or a second
 * tab can change an entity while its editor is open. A clean editor just
 * follows the newer values; a dirty one must never submit the stale fields it
 * still shows, so the caller is told and the user decides.
 */
function useUpstreamGuard<T extends { id: string }>(
  entity: T,
  dirty: boolean,
  reset: () => void
): { stale: boolean; reload: () => void; keepMine: () => void } {
  const upstream = JSON.stringify(entity);
  const [base, setBase] = useState(upstream);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  // A different node in the inspector always starts a fresh draft.
  useEffect(() => {
    resetRef.current();
    setBase(JSON.stringify(entity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id]);

  useEffect(() => {
    if (dirty || upstream === base) return;
    resetRef.current();
    setBase(upstream);
  }, [upstream, base, dirty]);

  return {
    stale: upstream !== base,
    reload: () => {
      resetRef.current();
      setBase(upstream);
    },
    keepMine: () => setBase(upstream),
  };
}

function StaleNotice({
  name,
  onReload,
  onKeepMine,
}: {
  name: string;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  return (
    <div role="alert" className="space-y-2 rounded-card border border-warn/25 bg-warn-dim p-3">
      <p className="flex gap-1.5 text-[13px] text-ink">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
        <span>
          {name} changed somewhere else while you were editing — a Navigator run, or another tab.
          Applying what is on screen now would put the older values back.
        </span>
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="quiet" onClick={onReload}>
          Load the new values
        </Button>
        <Button size="sm" variant="ghost" onClick={onKeepMine}>
          Keep mine
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- bindings -------------------------------- */

/** What a node is called on any surface, whatever kind it is. */
export function nodeLabel(m: Manifest, id: string): string {
  return (
    m.services.find((s) => s.id === id)?.name ??
    m.resources.find((r) => r.id === id)?.name ??
    m.routes.find((r) => r.id === id)?.host ??
    id
  );
}

const CAPABILITY_OPTIONS = [
  { value: "sql", label: "sql — relational database" },
  { value: "cache", label: "cache — key/value cache" },
  { value: "blob", label: "blob — object storage" },
  { value: "queue_publish", label: "queue_publish — sends work" },
  { value: "queue_consume", label: "queue_consume — takes work" },
  { value: "smtp", label: "smtp — transactional email" },
  { value: "http", label: "http — request/response" },
];

/**
 * A connection, opened on its own. There is no update action for a binding:
 * `system.bind` refuses an edge that already exists, so changing the capability
 * or the note is genuinely two changes — remove, then draw again — and the
 * panel says so rather than pretending one button does it.
 */
export function BindingEditor({ binding }: { binding: Binding }) {
  const { project } = useProjectData();
  const m = project.workingManifest;
  const [editing, setEditing] = useState(false);
  const [capability, setCapability] = useState<string>(binding.capability);
  const [note, setNote] = useState(binding.note ?? "");
  /** step 2 of the redraw: the old edge is gone, the new one is not there yet */
  const [removed, setRemoved] = useState(false);

  const injected = bindingEnv(m, binding);
  const changed = capability !== binding.capability || note !== (binding.note ?? "");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-card border border-line bg-bg1 px-3 py-2.5 text-[13px] text-ink">
        <span className="truncate">{nodeLabel(m, binding.from)}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="truncate">{nodeLabel(m, binding.to)}</span>
        <Chip className="ml-auto">{binding.capability}</Chip>
      </div>

      <Facts
        rows={[
          ["Capability", binding.capability],
          ["Note", binding.note ?? "—"],
          [
            "Injects",
            injected.length ? (
              <span className="font-mono">{injected.map((e) => e.key).join(", ")}</span>
            ) : (
              "nothing"
            ),
          ],
        ]}
      />

      {removed ? (
        <div role="alert" className="space-y-3 rounded-card border border-warn/25 bg-warn-dim p-3">
          <p className="text-[13px] text-ink">
            Step 2 of 2. The connection is out of the working copy right now — the Changes panel
            lists the removal. Draw it again with the new values, or leave it removed.
          </p>
          <PlanFirst
            actionId="system.bind"
            input={{
              from: binding.from,
              to: binding.to,
              capability,
              note: note.trim() || undefined,
            }}
            label="Preview the new connection"
            onDone={() => {
              setRemoved(false);
              setEditing(false);
            }}
          />
        </div>
      ) : editing ? (
        <div className="space-y-3 rounded-card border border-line p-3">
          <p className="text-[12.5px] text-ink-mute">
            Orrery has no action that edits a connection in place, so this is two changes: the
            connection is removed, then drawn again with the values below. Both are previewed
            before anything happens, and neither touches a running environment until you deploy.
          </p>
          <Field label="Capability" help="Decides which environment variables get injected.">
            <Select
              options={CAPABILITY_OPTIONS}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
            />
          </Field>
          <Field label="Note" help="Why this connection exists. Shown on the map and in the diff.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <PlanFirst
            actionId="system.unbind"
            input={{ bindingId: binding.id }}
            label="Step 1 — preview the removal"
            disabled={!changed}
            disabledReason="Change the capability or the note first — there is nothing to redraw yet."
            onDone={() => setRemoved(true)}
            onCancel={() => {
              setCapability(binding.capability);
              setNote(binding.note ?? "");
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="quiet"
            icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={() => setEditing(true)}
          >
            Change capability or note
          </Button>
        </div>
      )}

      {!editing && !removed && (
        <div className="space-y-2 border-t border-line pt-4">
          <p className="text-[13px] text-ink-mute">
            {nodeLabel(m, binding.from)} loses its {binding.capability} configuration for{" "}
            {nodeLabel(m, binding.to)}. Nothing changes in a running environment until you deploy.
          </p>
          <PlanFirst
            actionId="system.unbind"
            input={{ bindingId: binding.id }}
            label="Disconnect"
            variant="danger"
          />
        </div>
      )}
    </div>
  );
}

function BindingList({
  nodeId,
  onOpen,
}: {
  nodeId: string;
  onOpen?: (bindingId: string) => void;
}) {
  const { project } = useProjectData();
  const m = project.workingManifest;
  const related = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);

  const label = (id: string) => nodeLabel(m, id);

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
            <div className="flex flex-wrap items-center gap-2">
              {onOpen && (
                <Button size="sm" variant="quiet" onClick={() => onOpen(b.id)}>
                  Open connection
                </Button>
              )}
              <PlanFirst
                actionId="system.unbind"
                input={{ bindingId: b.id }}
                label="Disconnect"
                variant="ghost"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ env & secrets ------------------------------ */

/**
 * One variable, editable where it is listed. `system.setEnvVar` overwrites a
 * key that already exists, so editing is the same action as adding — there was
 * never a reason to make people remove and retype a value to change it.
 */
function EnvRow({ serviceId, entry }: { serviceId: string; entry: Service["env"][number] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.value ?? "");

  const secret = Boolean(entry.secretRef);
  const changed = value !== (entry.value ?? "");

  return (
    <li className="group space-y-1.5 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] text-ink">{entry.key}</span>
        {editing ? (
          <Input
            value={value}
            mono
            autoFocus
            aria-label={`Value of ${entry.key}`}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-ink-mute">
            {secret ? (
              <span title={`Recorded as a reference (${entry.secretRef}); Orrery has no copy of the value.`}>
                •••••••• <span className="text-ink-faint">secret</span>
              </span>
            ) : (
              entry.value
            )}
          </span>
        )}
      </div>
      {/* Quiet, never invisible — an opacity-0 control does not
          exist on a touch screen or to anyone scanning the list. */}
      <div className="flex flex-wrap items-center gap-2 opacity-60 transition-opacity duration-[120ms] group-hover:opacity-100 focus-within:opacity-100">
        {editing ? (
          <PlanFirst
            actionId="system.setEnvVar"
            input={{ serviceId, key: entry.key, value }}
            label="Save value"
            variant="quiet"
            disabled={!changed}
            disabledReason="The value is unchanged — there is nothing to apply."
            onDone={() => setEditing(false)}
            onCancel={() => {
              setValue(entry.value ?? "");
              setEditing(false);
            }}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={secret}
            disabledReason="A secret's value is not stored in Orrery, so there is nothing here to edit. Set it again under Add a secret to replace the reference."
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        <PlanFirst
          actionId="system.setEnvVar"
          input={{ serviceId, key: entry.key, value: null }}
          label="Remove"
          variant="ghost"
        />
      </div>
    </li>
  );
}

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
              <EnvRow key={e.key} serviceId={service.id} entry={e} />
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
          The manifest records only a reference — the value never lands in the diff, the audit log
          or an export bundle.
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
          <Field
            label="Value"
            help="Not stored yet. Orrery has no secret store in this build: only the reference is written, and the value you type here is discarded. Put the real value in your provider's secret manager under that reference."
          >
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
          label="Write the reference"
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

const KIND_OPTIONS = [
  { value: "web", label: "web — serves HTTP" },
  { value: "worker", label: "worker — long-running background process" },
  { value: "cron", label: "cron — runs on a schedule" },
  { value: "static", label: "static — prebuilt files" },
];

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

export function ServiceEditor({
  service,
  onOpenBinding,
}: {
  service: Service;
  onOpenBinding?: (bindingId: string) => void;
}) {
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
            <ul className="space-y-1.5 rounded-card border border-warn/25 bg-warn-dim p-3">
              {issues.map((i) => (
                <li key={i.field} className="flex gap-1.5 text-[12.5px] text-ink">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
                  <span>{i.reason}</span>
                </li>
              ))}
            </ul>
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

/* -------------------------------- resources -------------------------------- */

const STATEFUL_KINDS = ["postgres", "redis", "object_store", "queue"];

export function ResourceEditor({
  resource,
  onOpenBinding,
}: {
  resource: Resource;
  onOpenBinding?: (bindingId: string) => void;
}) {
  const { project } = useProjectData();
  const [tab, setTab] = useState("config");
  const [name, setName] = useState(resource.name);
  const [size, setSize] = useState<ServiceSize>(resource.size);

  const managed = resource.ownership === "managed";
  const { current, projected } = useMemo(
    () => resourceCost(project.workingManifest, resource.id, { size }),
    [project.workingManifest, resource.id, size]
  );

  const input: Record<string, unknown> = { resourceId: resource.id };
  // An emptied name is not a rename: the update action ignores "" and the form
  // would have offered to apply nothing at all.
  if (name.trim() && name.trim() !== resource.name) input.name = name.trim();
  if (size !== resource.size) input.size = size;
  const dirty = Object.keys(input).length > 1;
  const nameCleared = !name.trim();
  const guard = useUpstreamGuard(resource, dirty, () => {
    setName(resource.name);
    setSize(resource.size);
  });

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
          {guard.stale && (
            <StaleNotice
              name={resource.name}
              onReload={guard.reload}
              onKeepMine={guard.keepMine}
            />
          )}
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
            deltaUsd={managed ? projected - current : undefined}
          />
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
            disabled={!dirty || guard.stale || nameCleared}
            disabledReason={
              guard.stale
                ? `${resource.name} changed underneath this form. Load the new values, or keep yours, before applying.`
                : nameCleared
                  ? "A resource always has a name. Put one back, or remove it from the Danger tab."
                  : "Change a field first — there is nothing to apply yet."
            }
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

      {tab === "bindings" && <BindingList nodeId={resource.id} onOpen={onOpenBinding} />}

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

/**
 * The address this route actually answers on, taken from the last deployment's
 * outputs rather than reassembled from the manifest — the manifest says what
 * was asked for, the outputs say what exists.
 */
function liveUrl(outputs: { kind: string; value: string; targetId?: string }[], route: Route) {
  const byTarget = outputs.find((o) => o.kind === "url" && o.targetId === route.id);
  if (byTarget) return byTarget.value;
  return outputs.find((o) => o.kind === "url" && o.value.includes(route.host))?.value;
}

export function RouteEditor({
  route,
  onOpenBinding,
}: {
  route: Route;
  onOpenBinding?: (bindingId: string) => void;
}) {
  const { project, deployments, selectedEnv, selectedEnvId } = useProjectData();
  const [tab, setTab] = useState("config");
  const [tls, setTls] = useState(route.tls);
  const [pathPrefix, setPathPrefix] = useState(route.pathPrefix);

  const latest = deployments.find((d) => d.environmentId === selectedEnvId);
  const url = latest ? liveUrl(latest.outputs, route) : undefined;
  const envName = selectedEnv?.name ?? "this environment";

  const input: Record<string, unknown> = { routeId: route.id };
  if (tls !== route.tls) input.tls = tls;
  if (pathPrefix !== route.pathPrefix) input.pathPrefix = pathPrefix.trim();
  const dirty = Object.keys(input).length > 1;
  const guard = useUpstreamGuard(route, dirty, () => {
    setTls(route.tls);
    setPathPrefix(route.pathPrefix);
  });

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
        <div className="space-y-4">
          {guard.stale && (
            <StaleNotice name={route.host} onReload={guard.reload} onKeepMine={guard.keepMine} />
          )}
          <Facts
            rows={[
              ["Host", <span key="h" className="font-mono">{route.host}</span>],
              ["DNS", route.managedDns ? "Orrery-managed hostname" : "your own hostname (CNAME)"],
            ]}
          />

          <div className="space-y-1.5 rounded-card border border-line bg-bg1 p-3">
            <SectionTitle>Live in {envName}</SectionTitle>
            {url ? (
              <div className="flex items-center gap-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-signal hover:underline"
                >
                  {url}
                </a>
                <CopyButton value={url} what="the live address" />
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-mute">
                {selectedEnv?.deployedRevisionId
                  ? `The last deployment to ${envName} published no address for ${route.host}. It answers once a deploy that includes this route succeeds.`
                  : `${envName} has never been deployed, so ${route.host} does not resolve yet.`}
              </p>
            )}
          </div>

          <p className="text-[12.5px] text-ink-mute">
            A hostname is an identity, not a setting — to change it, publish a new route and remove
            this one, so the old address keeps working until you say otherwise.
          </p>

          <div className="flex items-center justify-between gap-3 rounded-ctl border border-line px-3 py-2">
            <div className="min-w-0">
              <span className="text-[13px] text-ink">TLS</span>
              <p className="text-[12px] text-ink-mute">
                {tls
                  ? route.managedDns
                    ? "Certificate issued and renewed by Orrery."
                    : "Certificate issues once the hostname resolves to this environment."
                  : "Traffic travels as plaintext — anything on the path can read it."}
              </p>
            </div>
            <Switch checked={tls} onChange={setTls} label="Serve over HTTPS" />
          </div>

          <Field
            label="Path prefix"
            help="Which requests on this hostname reach this route. Leading slash added if you leave it off."
          >
            <Input value={pathPrefix} mono onChange={(e) => setPathPrefix(e.target.value)} />
          </Field>

          <PlanFirst
            actionId="system.updateRoute"
            input={input}
            label="Apply change"
            disabled={!dirty || guard.stale}
            disabledReason={
              guard.stale
                ? `${route.host} changed underneath this form. Load the new values, or keep yours, before applying.`
                : "Change TLS or the path prefix first — there is nothing to apply yet."
            }
            onCancel={
              dirty
                ? () => {
                    setTls(route.tls);
                    setPathPrefix(route.pathPrefix);
                  }
                : undefined
            }
          />
        </div>
      )}

      {tab === "bindings" && <BindingList nodeId={route.id} onOpen={onOpenBinding} />}

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
  const { project } = useProjectData();
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

  // What this service will cost before it exists — the same number the editor
  // shows afterwards, priced through the same function.
  const monthlyUsd = nodeMonthlyCostUsd(
    {
      ...project.workingManifest,
      services: [
        {
          id: "draft",
          name: name.trim() || "draft",
          kind,
          source: { type: "image", image: image.trim() || "draft" },
          size,
          replicas: kind === "cron" || kind === "static" ? 1 : Number(replicas) || 0,
          env: [],
          ownership: "managed",
        },
      ],
    },
    "draft"
  );

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
      <SizeField value={size} onChange={setSize} monthlyUsd={monthlyUsd} />
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

  const resourceMonthlyUsd = nodeMonthlyCostUsd(
    {
      ...project.workingManifest,
      resources: [
        {
          id: "draft",
          name: name.trim() || "draft",
          kind,
          size,
          ownership: "managed",
          config: {},
        },
      ],
    },
    "draft"
  );

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
      <SizeField value={size} onChange={setSize} monthlyUsd={resourceMonthlyUsd} />
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
