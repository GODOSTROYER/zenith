"use client";
/**
 * Onboarding — three decisions, in order, with nothing hidden.
 *
 * Nothing is created until the last step's button: abandoning the flow leaves
 * no phantom project, no phantom environment. The workspace is the exception
 * and it says so — it is the account, not a resource.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleDashed,
  FileCode2,
  Layers,
  Lock,
  PlusSquare,
  Sparkles,
} from "lucide-react";
import { api, ApiError, executeAction, useJson } from "@/lib/client/api";
import type { CloudConnection, Workspace } from "@/lib/domain/types";
import type { ImportReport } from "@/lib/importers/types";
import { cx, fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Input,
  Skeleton,
  ThemeToggle,
  type ChipTone,
} from "@/components/ui";
import { ErrorNote, useSafeToasts } from "./shared";

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

/** What each non-sandbox provider can honestly do today. */
const AVAILABILITY_NOTE: Record<ProviderInfo["availability"], string> = {
  available: "Deploys run end to end.",
  preview: "Plan and Terraform export only — Orrery does not apply changes to it yet.",
  planned: "Not implemented. Nothing would happen if you picked it.",
};

const STEPS = [
  { n: 1, title: "Name your workspace", hint: "Where your projects live" },
  { n: 2, title: "Where will you run?", hint: "Provider and exact access" },
  { n: 3, title: "Start your system", hint: "Blueprint, import, or blank" },
] as const;

type Mode = "blueprint" | "import" | "blank";

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

  const [step, setStep] = useState(1);
  const [settled, setSettled] = useState(false);

  // A workspace that already exists means step 1 is behind us. `?step=3` (the
  // overview's "New project" card) skips straight to the system picker.
  useEffect(() => {
    if (settled || boot.loading) return;
    const wanted = Number(params.get("step"));
    if (hasWorkspace) setStep(wanted === 2 ? 2 : 3);
    else setStep(1);
    setSettled(true);
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
          </div>
          <ThemeToggle />
        </div>

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
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <StepSystem
            blueprints={blueprints}
            sampleCompose={sampleCompose}
            onBack={() => setStep(2)}
            onCreated={(slug, message) => {
              toasts.push({ kind: "ok", title: message });
              router.push(`/p/${slug}`);
            }}
          />
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
          return (
            <li key={s.n}>
              <button
                type="button"
                onClick={() => onGo(s.n)}
                disabled={state === "todo"}
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
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 border-t border-line px-3 pt-5 text-[12px] leading-relaxed text-ink-faint">
        Nothing is created until the last step. Leave at any point and no project, environment
        or cost is left behind.
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
  onNext: () => void;
}) {
  const sandboxConn = connections.find((c) => c.provider === "sandbox");
  const sandbox = providers.find((p) => p.id === "sandbox");
  const others = providers.filter((p) => p.id !== "sandbox");

  if (loading && providers.length === 0) return <Skeleton height={240} />;

  return (
    <div className="max-w-[760px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Orrery deploys into your cloud, never ours. Today only the sandbox executes end to end —
        the rest are labelled exactly as honestly as they behave.
      </p>

      {sandbox && (
        <button
          type="button"
          onClick={onNext}
          className="block w-full rounded-card border border-signal/50 bg-bg2 p-5 text-left ring-1 ring-signal/20 transition-colors duration-[var(--dur-fast)] hover:border-signal"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[16px] font-medium text-ink">{sandbox.displayName}</h2>
              <p className="mt-1 max-w-[52ch] text-[13px] text-ink-mute">
                Full simulated execution, no cloud account. Deployments, logs, health and cost
                estimates all run inside Orrery.
              </p>
            </div>
            <Chip tone="ok" icon={<Check className="h-3 w-3" />}>
              Available
            </Chip>
          </div>
        </button>
      )}

      <Card
        title="Exact access this grants"
        subtitle="Every connection lists what it can touch, before you pick it."
      >
        <ul className="space-y-2 text-[13px] text-ink-mute">
          {(sandboxConn?.grantedPermissions ?? [
            "No cloud access — the sandbox runs inside Orrery and simulates deployments.",
          ]).map((p) => (
            <li key={p} className="flex gap-2.5">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="space-y-3">
        <h3 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Real clouds — not selectable yet
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {others.map((p) => (
            <div
              key={p.id}
              title={
                p.availability === "preview"
                  ? `${p.displayName} is Preview: Orrery plans and exports Terraform for it, but cannot apply changes yet. Deploy to the sandbox, then export.`
                  : `${p.displayName} is Planned. Picking it would do nothing.`
              }
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

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} icon={<ArrowRight className="h-3.5 w-3.5" />}>
          Use the sandbox
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

function StepSystem({
  blueprints,
  sampleCompose,
  onBack,
  onCreated,
}: {
  blueprints: BlueprintCard[];
  sampleCompose: string;
  onBack: () => void;
  onCreated: (slug: string, message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("blueprint");
  const [selected, setSelected] = useState<string>(blueprints[0]?.id ?? "");
  const [compose, setCompose] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [review, setReview] = useState<{ report: ImportReport; slug: string; summary: string }>();

  const chosen = useMemo(
    () => blueprints.find((b) => b.id === selected),
    [blueprints, selected]
  );

  const projectName =
    name.trim() || (mode === "blueprint" ? (chosen?.name ?? "") : mode === "import" ? "Imported app" : "");

  const canCreate =
    mode === "blueprint" ? !!chosen : mode === "import" ? compose.trim().length > 0 : !!name.trim();

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const call =
        mode === "blueprint"
          ? { actionId: "project.applyBlueprint", input: { blueprint: selected, name: projectName } }
          : mode === "import"
            ? { actionId: "project.importCompose", input: { composeYaml: compose, name: projectName } }
            : { actionId: "project.create", input: { name: projectName } };

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
      <ImportReview
        report={review.report}
        summary={review.summary}
        onFinish={() => onCreated(review.slug, "Import complete — every element is accounted for.")}
      />
    );

  return (
    <div className="max-w-[860px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Start from a shape that already works, bring a compose file you already have, or begin
        with nothing. All three end in the same editable system.
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
          title="Import compose"
          body="Bring a docker-compose.yml. Every element is mapped or explained."
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
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="compose" className="text-[13px] text-ink">
              Paste your compose file
            </label>
            <Button
              variant="quiet"
              size="sm"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              disabled={!sampleCompose}
              disabledReason="The sample app fixture is missing from this build."
              onClick={() => setCompose(sampleCompose)}
            >
              Use sample app
            </Button>
          </div>
          <textarea
            id="compose"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            spellCheck={false}
            placeholder={"version: \"3.9\"\nservices:\n  web:\n    image: my/app:latest\n    ports:\n      - \"3000:3000\""}
            className="h-[320px] w-full resize-y rounded-card border border-line bg-bg1 p-3 font-mono text-[13px] leading-[1.6] text-ink outline-none placeholder:text-ink-faint focus-visible:border-signal"
          />
          <p className="text-[12.5px] text-ink-mute">
            Nothing is silently dropped: anything Orrery cannot translate is listed with a reason
            before you finish.
          </p>
        </div>
      )}

      {mode === "blank" && (
        <Card title="An empty system" subtitle="You add services and resources on the System map.">
          <p className="text-[13px] text-ink-mute">
            Creates the project and one sandbox environment. Nothing is deployed and nothing
            costs anything until you deploy.
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
              ? "Paste a compose file, or load the sample app."
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

/* ----------------------------- import review ------------------------------ */

function ImportReview({
  report,
  summary,
  onFinish,
}: {
  report: ImportReport;
  summary: string;
  onFinish: () => void;
}) {
  return (
    <div className="max-w-[860px] space-y-6 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">{summary}</p>

      <Card
        title={`${report.mapped.length} element${report.mapped.length === 1 ? "" : "s"} mapped`}
        subtitle="Exact means a faithful translation. Assumed means Orrery had to guess — check those."
        padded={false}
      >
        <ul>
          {report.mapped.map((m) => (
            <li
              key={m.source}
              className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
            >
              <Chip tone={m.confidence === "exact" ? "ok" : "warn"} className="mt-0.5">
                {m.confidence}
              </Chip>
              <div className="min-w-0">
                <p className="font-mono text-[12.5px] text-ink">
                  {m.source} <span className="text-ink-faint">→</span> {m.result}
                </p>
                <p className="mt-0.5 text-[12.5px] text-ink-mute">{m.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {report.unmapped.length > 0 && (
        <Card
          title={`${report.unmapped.length} not imported`}
          subtitle="Each one says why, and what to do instead."
          padded={false}
        >
          <ul>
            {report.unmapped.map((u) => (
              <li
                key={u.source}
                className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
              >
                <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px] text-ink">{u.source}</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-mute">{u.reason}</p>
                  <p className="mt-0.5 text-[12.5px] text-signal">{u.suggestion}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1.5 rounded-card border border-warn/30 bg-warn-dim px-4 py-3 text-[13px] text-ink">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {report.mapped.length === 0 && report.unmapped.length === 0 && (
        <EmptyState
          title="Nothing to report"
          body="The importer produced no mapping detail for this file."
        />
      )}

      <Button onClick={onFinish} icon={<ArrowRight className="h-3.5 w-3.5" />}>
        Open the system map
      </Button>
    </div>
  );
}
