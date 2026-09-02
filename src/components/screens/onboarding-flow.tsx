"use client";
/**
 * Onboarding — three decisions, in order, with nothing hidden.
 *
 * Nothing is created until the last step's button: abandoning the flow leaves
 * no phantom project, no phantom environment and no phantom cloud connection.
 * The workspace is the exception and it says so — it is the account, not a
 * resource. The connection has to exist before the first environment can point
 * at it, so the last step creates the two together, in that order.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  FileCode2,
  Layers,
  Lock,
  PlusSquare,
  Sparkles,
  Upload,
} from "lucide-react";
import { api, ApiError, executeAction, useJson } from "@/lib/client/api";
import type { CloudConnection, Workspace } from "@/lib/domain/types";
import { importDockerfile, importTerraform } from "@/lib/importers";
import type { ImportReport } from "@/lib/importers/types";
import { cx, fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  Field,
  Input,
  SegmentedControl,
  Skeleton,
  Textarea,
  ThemeToggle,
  type ChipTone,
} from "@/components/ui";
import { ErrorNote, useSafeToasts } from "./shared";
import { ImportReportView } from "./import-report";

export interface BlueprintCard {
  id: string;
  name: string;
  description: string;
  highlights: string[];
  nodes: number;
  services: number;
  resources: number;
  monthlyUsd: number;
}

interface ProviderInfo {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
  regions: { id: string; label: string }[];
}

interface Bootstrap {
  workspace: Workspace;
  connections: CloudConnection[];
  providers: ProviderInfo[];
}

const AVAILABILITY_TONE: Record<ProviderInfo["availability"], ChipTone> = {
  available: "ok",
  preview: "warn",
  planned: "neutral",
};

const AVAILABILITY_LABEL: Record<ProviderInfo["availability"], string> = {
  available: "Available",
  preview: "Preview",
  planned: "Planned",
};

/** What a provider can honestly do today, straight off its adapter's availability. */
const AVAILABILITY_NOTE: Record<ProviderInfo["availability"], string> = {
  available: "Deploys run end to end.",
  preview: "Plan and Terraform export only — Orrery does not apply changes to it yet.",
  planned: "Not implemented. Nothing would happen if you picked it.",
};

/**
 * What a provider needs from the machine it runs against, when that is not
 * Orrery itself. Availability says the adapter works; it cannot say your
 * Docker is running. Providers listed here are probed on render through
 * GET /api/providers/:id/health, so the card reports what it found instead of
 * promising an end-to-end deploy the machine cannot do.
 */
const PROVIDER_PREREQUISITE: Record<string, string> = {
  localstack:
    "Needs LocalStack listening on localhost:4566 (Docker Desktop running, then `localstack start`).",
};

/** GET /api/providers/:id/health */
interface ProviderHealth {
  ok: boolean;
  checks: { id: string; label: string; status: string; detail?: string; fix?: string }[];
  probe?: { reachable: boolean; detail?: string; fix?: string };
  availability: ProviderInfo["availability"];
  displayName: string;
}

/** Why a provider cannot be picked. Only ever called for non-available ones. */
function notSelectableReason(p: ProviderInfo): string {
  return p.availability === "preview"
    ? `${p.displayName} is Preview: Orrery plans and exports Terraform for it, but cannot apply changes yet. Pick a provider marked Available, then export.`
    : `${p.displayName} is Planned, not implemented. Picking it would do nothing.`;
}

const STEPS = [
  { n: 1, title: "Name your workspace", hint: "Where your projects live" },
  { n: 2, title: "Where will you run?", hint: "Provider and exact access" },
  { n: 3, title: "Start your system", hint: "Blueprint, import, or blank" },
] as const;

/** Why a rail step is not reachable yet — no disabled control is ever silent. */
const RAIL_LOCKED: Record<number, string> = {
  2: "Name your workspace first — the provider step needs somewhere to put the connection.",
  3: "Pick where you will run first. Step 3 creates the project against that choice.",
};

type Mode = "blueprint" | "import" | "blank";

/** What step 2 settled on. Nothing is created there — this is a choice, not a record. */
interface ProviderChoice {
  providerId: string;
  /** an existing connection for that provider, when the workspace already has one */
  connectionId?: string;
  displayName: string;
}

export function OnboardingFlow({
  blueprints,
  sampleCompose,
}: {
  blueprints: BlueprintCard[];
  sampleCompose: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toasts = useSafeToasts();
  const boot = useJson<Bootstrap>("/api/bootstrap");
  const hasWorkspace = !!boot.data?.workspace;
  // 404 is the ordinary first-run answer ("no workspace yet"), which step 1
  // exists to fix. Anything else is a real failure and must not be papered
  // over with a step the user cannot complete.
  const bootFailed = boot.error && boot.error.status !== 404;

  const [step, setStep] = useState(1);
  const [settled, setSettled] = useState(false);
  const [redirect, setRedirect] = useState<string>();
  /** what step 2 settled on; step 3 connects it and builds the environment */
  const [choice, setChoice] = useState<ProviderChoice>();

  // `?step=` is honoured when it is reachable. A workspace that already exists
  // means step 1 is behind us, so the default without a parameter is step 3
  // (the overview's "New project" card). A step that is not reachable yet is
  // never silently swapped for another — the redirect says so.
  useEffect(() => {
    if (settled || boot.loading) return;
    setSettled(true);
    const raw = params.get("step");
    const wanted = Number(raw);
    const asked = raw !== null && Number.isInteger(wanted) && wanted >= 1 && wanted <= 3;

    if (!hasWorkspace) {
      setStep(1);
      if (asked && wanted > 1)
        setRedirect(
          `You asked for step ${wanted}, but this workspace does not exist yet. Starting at step 1 — the rest needs a workspace to hang off.`
        );
      else if (raw !== null && !asked)
        setRedirect(`There is no step "${raw}". Starting at step 1.`);
      return;
    }

    if (asked) {
      setStep(wanted);
      return;
    }
    setStep(3);
    if (raw !== null) setRedirect(`There is no step "${raw}". Showing the system picker.`);
  }, [settled, boot.loading, hasWorkspace, params]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1160px] gap-14 px-8 py-12 lg:px-12">
      <Rail step={step} onGo={(n) => (n < step || (n === 2 && hasWorkspace)) && setStep(n)} />

      <main className="min-w-0 flex-1 pb-16">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-[12px] tracking-[0.08em] text-signal uppercase">Orrery</p>
            <h1 className="mt-2 text-[40px] leading-[1.1] font-medium tracking-[-0.02em] text-ink">
              {STEPS[step - 1].title}
            </h1>
            {/* The rail is the progress indicator from md up; below it, this is. */}
            <p className="mt-2 text-[12.5px] text-ink-faint md:hidden">
              Step {step} of {STEPS.length} · {STEPS[step - 1].hint} · nothing is created until
              step {STEPS.length}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasWorkspace && (
              <Button variant="quiet" size="sm" onClick={() => router.push("/overview")}>
                Leave setup
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>

        {redirect && (
          <p
            role="status"
            className="mb-6 rounded-card border border-info/30 bg-info-dim px-4 py-2.5 text-[13px] text-ink"
          >
            {redirect}
          </p>
        )}

        {bootFailed ? (
          <div className="max-w-[620px] space-y-4">
            <ErrorNote error={boot.error} />
            <p className="text-[13px] text-ink-mute">
              Onboarding reads your workspace, connections and providers from{" "}
              <span className="font-mono text-[12.5px] text-ink">/api/bootstrap</span> before it
              can show you a step it can actually finish.
            </p>
            <Button onClick={boot.refresh} icon={<ArrowRight className="h-3.5 w-3.5" />}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {step === 1 && (
              <StepWorkspace
                existing={boot.data?.workspace}
                loading={boot.loading}
                onDone={() => {
                  boot.refresh();
                  setStep(2);
                }}
              />
            )}

            {step === 2 && (
              <StepProvider
                providers={boot.data?.providers ?? []}
                connections={boot.data?.connections ?? []}
                loading={boot.loading}
                onBack={() => setStep(1)}
                onNext={(next) => {
                  setChoice(next);
                  setStep(3);
                }}
              />
            )}

            {step === 3 && (
              <StepSystem
                blueprints={blueprints}
                sampleCompose={sampleCompose}
                choice={choice}
                onBack={() => setStep(2)}
                onCreated={(slug, message) => {
                  toasts.push({ kind: "ok", title: message });
                  router.push(`/p/${slug}`);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------------------------- rail ---------------------------------- */

function Rail({ step, onGo }: { step: number; onGo: (n: number) => void }) {
  return (
    <nav aria-label="Setup progress" className="sticky top-12 hidden h-fit w-[212px] shrink-0 md:block">
      <ol className="space-y-1">
        {STEPS.map((s) => {
          const state = s.n < step ? "done" : s.n === step ? "current" : "todo";
          const locked = state === "todo" ? RAIL_LOCKED[s.n] : undefined;
          return (
            <li key={s.n}>
              <button
                type="button"
                onClick={() => onGo(s.n)}
                disabled={state === "todo"}
                title={locked ?? (state === "done" ? `Go back to: ${s.title}` : undefined)}
                aria-describedby={locked ? `rail-locked-${s.n}` : undefined}
                className={cx(
                  "flex w-full items-start gap-3 rounded-ctl px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)]",
                  state === "current" ? "bg-bg2" : "hover:bg-bg1",
                  state === "todo" && "cursor-default"
                )}
              >
                <span
                  className={cx(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px]",
                    state === "done" && "border-signal bg-signal text-on-signal",
                    state === "current" && "border-signal text-signal",
                    state === "todo" && "border-line text-ink-faint"
                  )}
                >
                  {state === "done" ? <Check className="h-3 w-3" /> : s.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={cx(
                      "block text-[13px]",
                      state === "todo" ? "text-ink-faint" : "text-ink"
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="block text-[12px] text-ink-faint">{s.hint}</span>
                  {locked && (
                    <span
                      id={`rail-locked-${s.n}`}
                      className="mt-1 block text-[11.5px] leading-relaxed text-ink-faint"
                    >
                      {locked}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 border-t border-line px-3 pt-5 text-[12px] leading-relaxed text-ink-faint">
        Nothing is created until the last step — not the project, not the environment, not the
        cloud connection. Leave at any point and no cost is left behind.
      </p>
    </nav>
  );
}

/* -------------------------------- step one -------------------------------- */

function StepWorkspace({
  existing,
  loading,
  onDone,
}: {
  existing: Workspace | undefined;
  loading: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    setConflict(null);
    try {
      await api<{ workspace: Workspace }>("/api/workspace", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(e.message);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton height={180} />;

  if (existing)
    return (
      <div className="max-w-[620px] space-y-6 animate-enter">
        <p className="text-[16px] leading-relaxed text-ink-mute">
          You already have a workspace: <span className="text-ink">{existing.name}</span>. Orrery
          runs one workspace locally, so this step is done.
        </p>
        <div className="flex gap-2">
          <Button onClick={onDone} icon={<ArrowRight className="h-3.5 w-3.5" />}>
            Continue
          </Button>
          <Button variant="quiet" onClick={() => router.push("/overview")}>
            Go to overview
          </Button>
        </div>
      </div>
    );

  return (
    <div className="max-w-[620px] space-y-7 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        A workspace holds your projects, cloud connections and audit history. One is enough —
        you can rename it later.
      </p>

      <Field
        label="Workspace name"
        help="Usually your company or team. It shows up in the top bar and in every audit entry."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && submit()}
          placeholder="Kepler Labs"
          maxLength={60}
          autoFocus
        />
      </Field>

      {conflict && (
        <div className="rounded-card border border-info/30 bg-info-dim px-4 py-3 text-[13px]">
          <p className="text-ink">{conflict}</p>
          <p className="mt-1 text-ink-mute">
            Local Orrery runs a single workspace. Use the one you have, or reset with{" "}
            <span className="font-mono">npm run seed</span>.
          </p>
          <Link href="/overview" className="mt-2 inline-block text-signal hover:underline">
            Open the workspace →
          </Link>
        </div>
      )}
      {error ? <ErrorNote error={error} /> : null}

      <Button
        busy={busy}
        disabled={!name.trim()}
        disabledReason="Give the workspace a name first."
        onClick={submit}
        icon={<ArrowRight className="h-3.5 w-3.5" />}
      >
        Create workspace
      </Button>
    </div>
  );
}

/* -------------------------------- step two -------------------------------- */

function StepProvider({
  providers,
  connections,
  loading,
  onBack,
  onNext,
}: {
  providers: ProviderInfo[];
  connections: CloudConnection[];
  loading: boolean;
  onBack: () => void;
  /** the provider the project's first environment should deploy through */
  onNext: (choice: ProviderChoice) => void;
}) {
  // Selectability comes from the adapter's own availability, never from a
  // hardcoded "sandbox is special" test — LocalStack reports available and is
  // therefore choosable, exactly as the README says.
  const selectable = providers.filter((p) => p.availability === "available");
  const rest = providers.filter((p) => p.availability !== "available");

  // A provider with a prerequisite is probed before it can be picked, so
  // "deploys run end to end" is a claim about this machine, not about the
  // adapter. Only one provider has a prerequisite today, so one call does it.
  const probeId = selectable.find((p) => PROVIDER_PREREQUISITE[p.id])?.id;
  const health = useJson<ProviderHealth>(
    probeId ? `/api/providers/${encodeURIComponent(probeId)}/health` : null
  );
  const probing = Boolean(probeId) && health.loading;
  const reachable = Boolean(health.data?.ok);
  /** null when the provider is fine (or has no prerequisite); a sentence otherwise. */
  const unreachable = (id: string): string | null => {
    if (id !== probeId || probing || reachable) return null;
    const from =
      health.data?.probe?.fix ??
      health.data?.checks.find((c) => c.status !== "pass")?.fix ??
      health.error?.fix;
    return `Not reachable: ${from ?? PROVIDER_PREREQUISITE[id] ?? "start it and reload this page."}`;
  };

  const [picked, setPicked] = useState<string>("");

  /** Available, and — where that depends on this machine — actually up. */
  const pickable = selectable.filter((p) => p.id !== probeId || (!probing && reachable));

  // The default is a real selection in state, not a render-time fallback, so
  // the card that looks chosen is the one aria-checked reports and the one the
  // Continue button names. A provider that turns out to be down drops the
  // selection rather than leaving a card that cannot be used looking chosen.
  const firstId = pickable[0]?.id;
  const pickedGone = picked !== "" && !pickable.some((p) => p.id === picked);
  useEffect(() => {
    if (!picked && firstId) setPicked(firstId);
    else if (pickedGone) setPicked(firstId ?? "");
  }, [picked, firstId, pickedGone]);

  const chosen = pickable.find((p) => p.id === picked);
  const existing = connections.find((c) => c.provider === chosen?.id);

  /** Arrow keys move the selection inside the group, as radios do. */
  const move = (dir: 1 | -1) => {
    if (pickable.length === 0) return;
    const at = pickable.findIndex((p) => p.id === picked);
    const next = pickable[(at + dir + pickable.length) % pickable.length];
    if (!next) return;
    setPicked(next.id);
    document.querySelector<HTMLElement>(`[data-provider="${CSS.escape(next.id)}"]`)?.focus();
  };

  if (loading && providers.length === 0) return <Skeleton height={240} />;

  return (
    <div className="max-w-[760px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Orrery deploys into your cloud, never ours. Every provider below is labelled exactly as
        honestly as it behaves, and only the ones that really execute can be picked.
      </p>

      <div className="space-y-3">
        <h3 id="providers-available" className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Available now — deploys run end to end
        </h3>
        <div role="radiogroup" aria-labelledby="providers-available" className="grid gap-3">
          {selectable.map((p) => {
            const active = p.id === chosen?.id;
            const conn = connections.find((c) => c.provider === p.id);
            const prerequisite = PROVIDER_PREREQUISITE[p.id];
            const down = unreachable(p.id);
            const checking = p.id === probeId && probing;
            const off = Boolean(down) || checking;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                data-provider={p.id}
                aria-checked={active}
                aria-disabled={off || undefined}
                disabled={off}
                title={down ?? (checking ? "Checking whether it is reachable…" : undefined)}
                tabIndex={active ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                    e.preventDefault();
                    move(1);
                  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    move(-1);
                  }
                }}
                onClick={() => !off && setPicked(p.id)}
                className={cx(
                  "block w-full rounded-card border p-5 text-left transition-colors duration-[var(--dur-fast)]",
                  active
                    ? "border-signal/50 bg-bg2 ring-1 ring-signal/20 hover:border-signal"
                    : "border-line bg-bg1 hover:border-line-strong",
                  off && "cursor-not-allowed opacity-70"
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-medium text-ink">{p.displayName}</h2>
                    <p className="mt-1 max-w-[52ch] text-[13px] text-ink-mute">{p.tagline}</p>
                    <p className="mt-1.5 text-[12.5px] text-ink-faint">
                      {conn
                        ? `Already connected as “${conn.label}” (${conn.status}).`
                        : p.id === "sandbox"
                          ? "Nothing to connect — the sandbox runs inside Orrery."
                          : `Nothing is connected yet. The last step connects it and runs its preflight checks${
                              p.regions[0] ? ` in ${p.regions[0].label}` : ""
                            }.`}
                    </p>
                    {conn && conn.status !== "healthy" && (
                      <p className="mt-1.5 text-[12.5px] text-warn">
                        That connection is {conn.status}. Re-check it in Settings → Connections
                        before you deploy through it.
                      </p>
                    )}
                    {prerequisite && (
                      <p
                        role={p.id === probeId ? "status" : undefined}
                        className={cx(
                          "mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed",
                          down ? "text-err" : "text-ink-faint"
                        )}
                      >
                        {checking ? `Checking ${p.displayName}…` : (down ?? prerequisite)}
                      </p>
                    )}
                  </div>
                  <Chip
                    tone={checking ? "neutral" : down ? "err" : "ok"}
                    icon={down || checking ? undefined : <Check className="h-3 w-3" />}
                    title={
                      p.id === probeId
                        ? "Checked against this machine just now, not just against the adapter."
                        : undefined
                    }
                  >
                    {checking ? "Checking…" : down ? "Not reachable" : "Available"}
                  </Chip>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Card
        title="Exact access this grants"
        subtitle="Every connection lists what it can touch, before you pick it."
      >
        <ul className="space-y-2 text-[13px] text-ink-mute">
          {(existing?.grantedPermissions ??
            (chosen?.id === "sandbox"
              ? ["No cloud access — the sandbox runs inside Orrery and simulates deployments."]
              : [
                  `Not connected yet. ${chosen?.displayName ?? "This provider"} lists the exact permissions it takes on the connection screen, before anything is created.`,
                ])
          ).map((p) => (
            <li key={p} className="flex gap-2.5">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </Card>

      {rest.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
            Not selectable yet
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {rest.map((p) => (
              <div
                key={p.id}
                title={notSelectableReason(p)}
                aria-disabled="true"
                className="rounded-card border border-line bg-bg1 p-4 opacity-80"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-[14px] text-ink">{p.displayName}</h4>
                  <Chip tone={AVAILABILITY_TONE[p.availability]}>
                    {AVAILABILITY_LABEL[p.availability]}
                  </Chip>
                </div>
                <p className="mt-1.5 text-[12.5px] text-ink-mute">{p.tagline}</p>
                <p className="mt-2 text-[12px] text-ink-faint">
                  {AVAILABILITY_NOTE[p.availability]}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={!chosen}
          disabledReason={
            probing
              ? "Still checking whether the available provider is reachable from this machine."
              : selectable.length > 0
                ? "The provider that reports itself available is not reachable from this machine. Start it and reload, or pick another once one ships."
                : "No provider reports itself available in this build, so there is nothing to deploy through."
          }
          onClick={() =>
            chosen &&
            onNext({
              providerId: chosen.id,
              connectionId: existing?.id,
              displayName: chosen.displayName,
            })
          }
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          {chosen ? `Use ${chosen.displayName}` : "Continue"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- step three ------------------------------- */

interface CreateResult {
  projectId?: string;
  slug?: string;
  environmentId?: string;
  report?: ImportReport;
}

type Format = "compose" | "terraform" | "dockerfile";

const FORMATS: {
  value: Format;
  label: string;
  title: string;
  accept: string;
  /** what the box wants, and what it honestly does with it */
  prompt: string;
  placeholder: string;
}[] = [
  {
    value: "compose",
    label: "compose",
    title: "docker-compose.yml — services, resources and the links between them.",
    accept: ".yml,.yaml,text/yaml,application/x-yaml,text/plain",
    prompt: "Services, images, ports and depends_on all translate. Volumes and build args do not.",
    placeholder: 'version: "3.9"\nservices:\n  web:\n    image: my/app:latest\n    ports:\n      - "3000:3000"',
  },
  {
    value: "terraform",
    label: "terraform",
    title: "A .tf file — recognised resources are imported as referenced, never provisioned.",
    accept: ".tf,.hcl,text/plain",
    prompt:
      "A text scan, not an HCL parse: modules, variables and count/for_each are not evaluated. What it recognises is imported as “referenced” — read, never changed.",
    placeholder: 'resource "aws_db_instance" "primary" {\n  engine = "postgres"\n}\n\nresource "aws_s3_bucket" "assets" {}',
  },
  {
    value: "dockerfile",
    label: "dockerfile",
    title: "A Dockerfile — one image, so one web service.",
    accept: "text/plain,.dockerfile",
    prompt:
      "One Dockerfile describes one image, so this produces exactly one web service. Build instructions stay in your Dockerfile.",
    placeholder: 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]',
  },
];

/**
 * Past this the input is a mistake, not a manifest — a 5 MB paste would parse
 * on the main thread and freeze the tab with no explanation.
 */
const MAX_IMPORT_CHARS = 256 * 1024;
const kb = (n: number) => Math.max(1, Math.round(n / 1024));
const OVERSIZE_FIX = `Keep the file under ${kb(MAX_IMPORT_CHARS)} KB — trim it to the services you want, or import them a few at a time.`;

function StepSystem({
  blueprints,
  sampleCompose,
  choice,
  onBack,
  onCreated,
}: {
  blueprints: BlueprintCard[];
  sampleCompose: string;
  /** what step 2 settled on; undefined means the default sandbox connection */
  choice?: ProviderChoice;
  onBack: () => void;
  onCreated: (slug: string, message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("blueprint");
  const [format, setFormat] = useState<Format>("compose");
  const [selected, setSelected] = useState<string>(blueprints[0]?.id ?? "");
  const [source, setSource] = useState("");
  const [sourceFile, setSourceFile] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [review, setReview] = useState<{ report: ImportReport; slug: string; summary: string }>();
  /** the usable connection, once this step has one */
  const [connectionId, setConnectionId] = useState(choice?.connectionId);
  /** created, but preflight did not pass — retrying re-checks it, never duplicates it */
  const [unusableConnectionId, setUnusableConnectionId] = useState<string>();

  const chosen = useMemo(
    () => blueprints.find((b) => b.id === selected),
    [blueprints, selected]
  );
  const spec = FORMATS.find((f) => f.value === format)!;
  const oversize = source.length > MAX_IMPORT_CHARS;

  const projectName =
    name.trim() || (mode === "blueprint" ? (chosen?.name ?? "") : mode === "import" ? "Imported app" : "");

  // Terraform and Dockerfile parse in the browser — the same importers the map
  // dialog uses — so the file is understood before anything is created.
  const parsed = useMemo(() => {
    if (mode !== "import" || format === "compose" || !source.trim() || oversize) return undefined;
    try {
      const out =
        format === "terraform"
          ? importTerraform(source)
          : importDockerfile(source, sourceFile?.replace(/\.[^.]+$/, "") || projectName || "app");
      return { manifest: out.manifest, report: out.report, error: undefined };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [mode, format, source, sourceFile, projectName, oversize]);

  const canCreate =
    mode === "blueprint"
      ? !!chosen
      : mode === "import"
        ? source.trim().length > 0 &&
          !oversize &&
          (format === "compose" || !!parsed?.manifest)
        : !!name.trim();

  const readFile = async (file: File) => {
    setError(undefined);
    if (file.size > MAX_IMPORT_CHARS) {
      setSourceFile(undefined);
      setError(new ApiError(`${file.name} is ${kb(file.size)} KB.`, 413, OVERSIZE_FIX));
      return;
    }
    try {
      setSource(await file.text());
      setSourceFile(file.name);
    } catch (err) {
      setSourceFile(undefined);
      setError(err);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // The connection has to exist before the environment can reference it,
      // so it is created here — at the last step — and not a moment earlier.
      let connId = connectionId;
      if (!connId && choice && choice.providerId !== "sandbox") {
        const conn = await executeAction(
          unusableConnectionId ? "connection.check" : "connection.create",
          {
            input: unusableConnectionId
              ? { connectionId: unusableConnectionId }
              : { provider: choice.providerId },
          }
        );
        const made = (conn.data as { connectionId?: string } | undefined)?.connectionId;
        if (!conn.ok) {
          // The connection row exists but its preflight did not pass. Fixing
          // the cause and pressing again re-checks that one.
          if (made) setUnusableConnectionId(made);
          setError(new ApiError(conn.summary, 400, conn.error));
          return;
        }
        connId = made;
        setConnectionId(made);
        setUnusableConnectionId(undefined);
      }

      // Compose creates the project in one action; Terraform and Dockerfile
      // parse here, so they create the project and then write the manifest
      // through the same audited action the Source view uses.
      const call =
        mode === "blueprint"
          ? {
              actionId: "project.applyBlueprint",
              input: { blueprint: selected, name: projectName, connectionId: connId },
            }
          : mode === "import" && format === "compose"
            ? {
                actionId: "project.importCompose",
                input: { composeYaml: source, name: projectName, connectionId: connId },
              }
            : { actionId: "project.create", input: { name: projectName, connectionId: connId } };

      const result = await executeAction(call.actionId, { input: call.input });
      if (!result.ok) {
        setError(new ApiError(result.summary, 400, result.error));
        return;
      }
      const data = (result.data ?? {}) as CreateResult;
      if (!data.slug) {
        setError(new ApiError(result.summary, 500, "The project was created but has no URL. Open it from the overview."));
        return;
      }

      if (mode === "import" && format !== "compose" && parsed?.manifest) {
        const applied = await executeAction("project.updateManifest", {
          input: { projectId: data.projectId, manifest: parsed.manifest },
          scope: { projectId: data.projectId },
        });
        if (!applied.ok) {
          setError(
            new ApiError(
              `The project was created, but the ${spec.label} import did not apply: ${applied.summary}`,
              400,
              applied.error ?? `Open /p/${data.slug} and import the file again from the map.`
            )
          );
          return;
        }
        setReview({
          report: parsed.report,
          slug: data.slug,
          summary: `Imported your ${spec.label} file into “${projectName}”. Nothing is deployed yet — this is what Orrery made of it.`,
        });
        return;
      }

      if (data.report) setReview({ report: data.report, slug: data.slug, summary: result.summary });
      else onCreated(data.slug, result.summary);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (review)
    return (
      <div className="max-w-[860px] space-y-6 animate-enter">
        <p className="text-[16px] leading-relaxed text-ink-mute">{review.summary}</p>
        <ImportReportView report={review.report} />
        <Button
          onClick={() => onCreated(review.slug, "Import complete — every element is accounted for.")}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          Open the system map
        </Button>
      </div>
    );

  return (
    <div className="max-w-[860px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Start from a shape that already works, bring a file you already have, or begin with
        nothing. All three end in the same editable system
        {choice ? `, deploying through ${choice.displayName}` : ""}.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <ModeCard
          icon={<Layers className="h-4 w-4" />}
          title="Blueprint"
          body="An opinionated starting system, priced before you commit."
          active={mode === "blueprint"}
          onClick={() => setMode("blueprint")}
        />
        <ModeCard
          icon={<FileCode2 className="h-4 w-4" />}
          title="Import a file"
          body="compose, Terraform or a Dockerfile. Every element is mapped or explained."
          active={mode === "import"}
          onClick={() => setMode("import")}
        />
        <ModeCard
          icon={<PlusSquare className="h-4 w-4" />}
          title="Blank"
          body="An empty system and one sandbox environment."
          active={mode === "blank"}
          onClick={() => setMode("blank")}
        />
      </div>

      <Field
        label="Project name"
        help={
          mode === "blueprint"
            ? `Leave blank to use “${chosen?.name ?? "the blueprint name"}”.`
            : mode === "import"
              ? "Leave blank to call it “Imported app”."
              : "Used for the URL: /p/<slug>."
        }
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mode === "blueprint" ? (chosen?.name ?? "Atlas") : "Atlas"}
          maxLength={60}
        />
      </Field>

      {mode === "blueprint" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {blueprints.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected(b.id)}
              aria-pressed={b.id === selected}
              className={cx(
                "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
                b.id === selected
                  ? "border-signal/60 ring-1 ring-signal/25"
                  : "border-line hover:border-line-strong"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-[14px] font-medium text-ink">{b.name}</h4>
                <span className="tnum shrink-0 text-[13px] text-ink">
                  {fmtUsd(b.monthlyUsd)}
                  <span className="text-ink-faint">/mo est.</span>
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{b.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {b.highlights.map((h) => (
                  <Chip key={h}>{h}</Chip>
                ))}
              </div>
              <p className="tnum mt-3 text-[11.5px] text-ink-faint">
                {b.nodes} nodes · {b.services} service{b.services === 1 ? "" : "s"} ·{" "}
                {b.resources} resource{b.resources === 1 ? "" : "s"}
              </p>
            </button>
          ))}
        </div>
      )}

      {mode === "import" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl<Format>
              size="sm"
              label="Import format"
              value={format}
              onChange={(f) => {
                setFormat(f);
                setSource("");
                setSourceFile(undefined);
                setError(undefined);
              }}
              options={FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title }))}
            />
            <div className="flex items-center gap-2">
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-ctl border border-line px-2.5 text-[12.5px] text-ink-mute transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:text-ink">
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                Choose a file
                <input
                  type="file"
                  accept={spec.accept}
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // let the same file be re-picked
                    if (file) await readFile(file);
                  }}
                />
              </label>
              {format === "compose" && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  disabled={!sampleCompose}
                  disabledReason="The sample app fixture is missing from this build."
                  onClick={() => {
                    setSource(sampleCompose);
                    setSourceFile(undefined);
                  }}
                >
                  Use sample app
                </Button>
              )}
            </div>
          </div>

          <label htmlFor="import-source" className="block text-[13px] text-ink">
            Paste your {spec.label} file, or choose it
          </label>
          <p className="text-[12.5px] leading-relaxed text-ink-mute">{spec.prompt}</p>

          {sourceFile && (
            <p className="text-[12.5px] text-ink-mute">
              Loaded <span className="font-mono text-ink">{sourceFile}</span> — it is editable
              below, and nothing is read from your disk again.
            </p>
          )}
          <Textarea
            id="import-source"
            mono
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSourceFile(undefined);
            }}
            spellCheck={false}
            placeholder={spec.placeholder}
            className="h-[320px]"
          />
          {oversize && (
            <p className="text-[12.5px] text-err">
              That is {kb(source.length)} KB of text. {OVERSIZE_FIX}
            </p>
          )}
          {parsed?.error && <p className="text-[12.5px] text-err">{parsed.error}</p>}
          <p className="text-[12.5px] leading-relaxed text-ink-mute">
            Nothing is silently dropped: anything Orrery cannot translate is listed with a reason
            before you finish. The import itself deploys nothing, so it costs nothing — the map
            prices every service and resource before your first deploy.
          </p>
        </div>
      )}

      {mode === "blank" && (
        <Card title="An empty system" subtitle="You add services and resources on the System map.">
          <p className="text-[13px] text-ink-mute">
            Creates the project and one sandbox environment. Nothing is deployed and nothing
            costs anything until you deploy.
          </p>
          <p className="tnum mt-2 text-[13px] text-ink">
            {fmtUsd(0)}
            <span className="text-ink-faint">/mo est. — an empty system prices at nothing, and the map prices each thing as you add it.</span>
          </p>
        </Card>
      )}

      {error ? <ErrorNote error={error} /> : null}

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          busy={busy}
          disabled={!canCreate}
          disabledReason={
            mode === "import"
              ? !source.trim()
                ? `Paste a ${spec.label} file, or choose one from disk.`
                : oversize
                  ? OVERSIZE_FIX
                  : (parsed?.error ?? "That file could not be read — see the message above.")
              : mode === "blank"
                ? "Give the project a name first."
                : "Pick a blueprint."
          }
          onClick={create}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          {mode === "import" ? "Import and review" : "Create project"}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  body,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
        active ? "border-signal/60 ring-1 ring-signal/25" : "border-line hover:border-line-strong"
      )}
    >
      <span className={cx("inline-flex", active ? "text-signal" : "text-ink-mute")}>{icon}</span>
      <h4 className="mt-2 text-[14px] font-medium text-ink">{title}</h4>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">{body}</p>
    </button>
  );
}
