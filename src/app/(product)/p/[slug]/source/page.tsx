"use client";
/**
 * Source — the system as code.
 *
 * The manifest is the one model: what you read here is exactly what the map
 * draws and what a deploy snapshots. Save validates, previews the resulting
 * changes, and replaces the working copy through project.updateManifest —
 * the same audited action pipeline the visual editor uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, FileJson, Info } from "lucide-react";
import type { ActionPlan } from "@/lib/actions/core";
import { planAction, useJson } from "@/lib/client/api";
import { diffManifests, validateManifest, type ValidationIssue } from "@/lib/domain/graph";
import { Manifest, type Revision } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  CostDelta,
  EmptyState,
  Kbd,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
} from "@/components/ui";
import { EditorBoundary } from "@/components/screens/editor-boundary";
import { ExportPanel } from "@/components/screens/export-panel";
import { ActionConfirm, ChangeRow, ErrorNote } from "@/components/screens/shared";
import { useSelectedEnv, type RevisionMeta } from "@/components/screens/project-data";
import { describeJsonError, type JsonErrorSite } from "./json-error";

const SAVE_NOTE =
  "Save validates the text, previews the resulting changes with their cost, and only then replaces the working copy — through the same audited action every other editor uses.";

/** Idle time before the editor checks the document on its own. */
const VALIDATE_DEBOUNCE_MS = 400;

/**
 * Line numbers stop being drawn past this. The gutter is decoration
 * (`aria-hidden`) and rebuilding a 5000-entry string on every newline is the
 * only per-keystroke cost the editor has; the textarea itself is unaffected.
 */
const MAX_GUTTER_LINES = 5000;

type ParseState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "error"; message: string; site?: JsonErrorSite }
  | { kind: "ok"; manifest: Manifest; issues: ValidationIssue[] };

/** One pass, no array of N strings — this runs on every keystroke. */
function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

export default function SourcePage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [tab, setTab] = useState("working");
  const [dirty, setDirty] = useState(false);

  const working = data?.project.workingManifest;
  const workingJson = useMemo(
    () => (working ? JSON.stringify(working, null, 2) : ""),
    [working]
  );

  if (!data || !working)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  // The payload already carries revision metadata, so the tab can name the
  // live revision without a second request for a manifest nobody is reading.
  const deployedMeta = data.revisions.find((r) => r.id === env?.deployedRevisionId);
  const deployedLabel = deployedMeta
    ? `Deployed (r${deployedMeta.number})`
    : env?.deployedRevisionId
      ? "Deployed"
      : "Deployed (none)";

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1100px] px-6 py-6">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "working",
            label: "Working copy",
            badge: dirty ? <Chip tone="warn">unsaved</Chip> : undefined,
          },
          { value: "deployed", label: deployedLabel },
          { value: "export", label: "Export" },
        ]}
      />

      <div className="mt-5">
        {/*
          The working copy stays mounted: switching tabs with unsaved text used
          to unmount the editor and throw the text away silently. Hidden, not
          discarded — the tab badge above says it is still there.
        */}
        <div hidden={tab !== "working"}>
          <WorkingTab
            active={tab === "working"}
            json={workingJson}
            manifest={working}
            projectId={projectId}
            slug={slug}
            onDirtyChange={setDirty}
            refresh={refresh}
          />
        </div>

        {tab === "deployed" && (
          <DeployedTab
            revisions={data.revisions}
            deployedRevisionId={env?.deployedRevisionId}
            envName={env?.name}
            working={working}
          />
        )}

        {tab === "export" && (
          <ExportPanel
            environmentId={env?.id}
            environmentName={env?.name}
            workingManifest={working}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------ working copy ------------------------------ */

function WorkingTab({
  active,
  json,
  manifest,
  projectId,
  slug,
  onDirtyChange,
  refresh,
}: {
  active: boolean;
  json: string;
  manifest: Manifest;
  projectId: string;
  slug: string;
  onDirtyChange: (dirty: boolean) => void;
  refresh: () => void;
}) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [text, setText] = useState(json);
  const [parse, setParse] = useState<ParseState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [hint, setHint] = useState<string>();
  const [serverPlan, setServerPlan] = useState<ActionPlan>();
  const [planError, setPlanError] = useState<unknown>();
  const [planning, setPlanning] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterBoxRef = useRef<HTMLDivElement>(null);
  const gutterTextRef = useRef<HTMLPreElement>(null);

  // The working copy can change under us (map edits, Navigator runs, another
  // tab). Adopt the new text when nothing is being edited; when something is,
  // keep what is typed and say so rather than silently losing either version.
  const [seen, setSeen] = useState(json);
  const [movedWhileEditing, setMovedWhileEditing] = useState(false);
  if (seen !== json) {
    const editing = text !== seen;
    setSeen(json);
    if (editing) setMovedWhileEditing(true);
    else setText(json);
  }

  const dirty = text !== json;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const validate = useCallback((source: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (e) {
      setParse({ kind: "error", ...describeJsonError(source, e) });
      return;
    }
    const parsed = Manifest.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setParse({
        kind: "error",
        message: `${first.path.join(".") || "manifest"}: ${first.message}. ${parsed.error.issues.length - 1} other schema problem(s).`,
      });
      return;
    }
    setParse({
      kind: "ok",
      manifest: parsed.data,
      issues: validateManifest(parsed.data),
    });
  }, []);

  // Validate while the operator is idle, so Save's state is usually already
  // known by the time they reach for it. The button below is still explicit.
  useEffect(() => {
    setParse({ kind: "checking" });
    setHint(undefined);
    setServerPlan(undefined);
    setPlanError(undefined);
    const t = setTimeout(() => validate(text), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, validate]);

  const changeset =
    parse.kind === "ok" ? diffManifests(manifest, parse.manifest) : undefined;
  const blockingIssues =
    parse.kind === "ok" && parse.issues.some((i) => i.level === "error");

  const lineCount = useMemo(() => countLines(text), [text]);
  const errLine = parse.kind === "error" ? parse.site?.line : undefined;
  const gutter = useMemo(() => gutterRows(lineCount, errLine), [lineCount, errLine]);
  const readLines = useMemo(() => countLines(json), [json]);

  /** Select the offending character and put its line on screen. */
  const revealSite = useCallback(
    (site: JsonErrorSite) => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(site.offset, Math.min(site.offset + 1, area.value.length));
      // Measured, not assumed: the gutter block is exactly as tall as the rows
      // it drew, so one row is its height over its row count.
      const pre = gutterTextRef.current;
      const rows = Math.min(lineCount, MAX_GUTTER_LINES);
      const rowHeight = pre && rows > 0 ? pre.getBoundingClientRect().height / rows : 0;
      if (rowHeight > 0)
        area.scrollTop = Math.max(0, (site.line - 1) * rowHeight - area.clientHeight / 3);
    },
    [lineCount]
  );

  const saveBlockedReason = !dirty
    ? "Nothing to save — the text matches the working copy."
    : parse.kind === "checking" || parse.kind === "idle"
      ? "Checking the JSON — this settles in a moment."
      : parse.kind === "error"
        ? "The document does not parse — fix the error shown below."
        : blockingIssues
          ? "Fix the validation errors first; they would block the next deploy."
          : undefined;

  /* S5 — Ctrl/Cmd+S saves, and says why when it cannot. */
  useEffect(() => {
    if (!active || mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (saveBlockedReason) setHint(saveBlockedReason);
      else setConfirmOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, mode, saveBlockedReason]);

  /* S3 — a reload or a closed tab is the one navigation the browser lets us stop. */
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  /** S11 — what the server says this same save would do, on demand. */
  const previewServerPlan = async () => {
    if (parse.kind !== "ok") return;
    setPlanning(true);
    setPlanError(undefined);
    try {
      setServerPlan(
        await planAction("project.updateManifest", {
          input: { manifest: parse.manifest },
          scope: { projectId },
        })
      );
    } catch (e) {
      setPlanError(e);
    } finally {
      setPlanning(false);
    }
  };

  const costDisagrees =
    !!serverPlan &&
    !!changeset &&
    Math.abs(serverPlan.costDeltaUsd - changeset.totalCostDeltaUsd) >= 0.01;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<"read" | "edit">
          label="Source mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "read", label: "Read", title: "The working manifest, formatted" },
            { value: "edit", label: "Edit", title: "Edit and validate before applying" },
          ]}
        />
        <p className="tnum text-[12.5px] text-ink-faint">
          {readLines} lines · {manifest.services.length} services ·{" "}
          {manifest.resources.length} resources · {manifest.bindings.length} bindings
        </p>
      </div>

      {movedWhileEditing && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-card border border-warn/30 bg-warn-dim px-4 py-3 text-[13px] text-ink"
        >
          <span className="min-w-0 flex-1">
            The working copy changed while you were editing — a map edit, a Navigator run or
            another tab. Your text is untouched; saving it replaces theirs.
          </span>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setText(json);
              setMovedWhileEditing(false);
            }}
          >
            Discard mine, load theirs
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMovedWhileEditing(false)}>
            Keep editing
          </Button>
        </div>
      )}

      {mode === "read" ? (
        <CodeBlock code={json} title="orrery.manifest.json" lineNumbers maxHeight={560} />
      ) : (
        <EditorBoundary
          onRestore={() => {
            setText(json);
          }}
        >
          <div className="space-y-4">
            {/*
              A textarea with a line-number gutter — no editor dependency, on
              purpose. The gutter is a single pre scrolled from the textarea's
              own scroll event; `wrap="off"` is what keeps the two in step,
              since a soft-wrapped line would take two rows in the textarea and
              one in the gutter. Height follows the viewport (S14).
            */}
            <div className="flex h-[clamp(320px,calc(100vh-360px),820px)] overflow-hidden rounded-card border border-line bg-bg1 focus-within:border-signal">
              <div
                ref={gutterBoxRef}
                aria-hidden="true"
                className="shrink-0 overflow-hidden border-r border-line bg-bg1 py-3 pr-2 pl-3 select-none"
              >
                <pre
                  ref={gutterTextRef}
                  className="tnum m-0 text-right font-mono text-[13px] leading-[1.65] text-ink-faint"
                >
                  {gutter}
                </pre>
              </div>
              <textarea
                ref={areaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onScroll={(e) => {
                  if (gutterBoxRef.current)
                    gutterBoxRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                spellCheck={false}
                wrap="off"
                aria-label="Manifest JSON"
                className="h-full w-full resize-none bg-transparent p-3 font-mono text-[13px] leading-[1.65] text-ink outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" onClick={() => validate(text)}>
                Validate
              </Button>
              <Button
                variant="quiet"
                disabled={parse.kind !== "ok" && parse.kind !== "checking"}
                disabledReason="The document does not parse, so there is nothing to reformat."
                title="Re-indent the JSON with two spaces"
                onClick={() => {
                  try {
                    setText(JSON.stringify(JSON.parse(text), null, 2));
                  } catch {
                    setHint("The document does not parse — fix the error below, then format.");
                  }
                }}
              >
                Format
              </Button>
              <Button
                disabled={Boolean(saveBlockedReason)}
                disabledReason={saveBlockedReason}
                title="Save (Ctrl/Cmd+S)"
                onClick={() => setConfirmOpen(true)}
              >
                Save
              </Button>
              <span className="hidden items-center gap-1 text-ink-faint sm:flex">
                <Kbd>Ctrl</Kbd>
                <Kbd>S</Kbd>
              </span>
              <Button
                variant="ghost"
                disabled={!dirty}
                disabledReason="The text already matches the working copy."
                onClick={() => setText(json)}
              >
                Revert
              </Button>
              {dirty && <Chip tone="warn">Unsaved text</Chip>}
              <ParseStatus parse={parse} />
            </div>

            {hint && (
              <p role="status" className="text-[12.5px] text-warn">
                {hint}
              </p>
            )}

            <div className="flex gap-2.5 rounded-card border border-line bg-bg1 px-4 py-3 text-[12.5px] text-ink-mute">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
              <p>{SAVE_NOTE}</p>
            </div>

            {parse.kind === "error" && (
              <div role="status" className="space-y-2">
                <ErrorNote error={new Error(parse.message)} />
                {parse.site ? <GoToLine site={parse.site} onGo={revealSite} /> : null}
              </div>
            )}

            {parse.kind === "ok" && <IssueList issues={parse.issues} slug={slug} />}

            {changeset && (
              <Card
                title={
                  changeset.items.length === 0
                    ? "No difference"
                    : `${changeset.items.length} change${changeset.items.length === 1 ? "" : "s"} vs the working copy`
                }
                subtitle={
                  changeset.items.length === 0
                    ? "This text describes the same system that is already loaded."
                    : `Projected ${fmtUsd(changeset.projectedMonthlyUsd)}/month after these changes (estimate), counted in this browser.`
                }
                actions={
                  changeset.items.length > 0 ? (
                    <CostDelta usd={changeset.totalCostDeltaUsd} />
                  ) : undefined
                }
                padded={changeset.items.length === 0}
              >
                {changeset.items.length === 0 ? null : (
                  <ul className="-mx-1">
                    {changeset.items.map((i) => (
                      <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} />
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {changeset && changeset.items.length > 0 && (
              <div className="space-y-2 rounded-card border border-line bg-bg1 px-4 py-3 text-[12.5px] text-ink-mute">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    That list is this browser&apos;s reading of the text. The server plans the
                    same save independently — and its plan is the one that applies.
                  </span>
                  <Button size="sm" variant="quiet" busy={planning} onClick={previewServerPlan}>
                    Compare with the server&apos;s plan
                  </Button>
                </div>
                {planError ? <ErrorNote error={planError} /> : null}
                {serverPlan && (
                  <div role="status" className="space-y-1">
                    <p className={costDisagrees ? "text-warn" : "text-ink"}>
                      {costDisagrees
                        ? `The two disagree: this page shows ${fmtUsd(changeset.totalCostDeltaUsd)}/month, the server's plan says ${fmtUsd(serverPlan.costDeltaUsd)}/month. Trust the server's — reload the page to pick up whatever changed underneath.`
                        : `Agreed: both make it ${fmtUsd(serverPlan.costDeltaUsd)}/month different.`}
                    </p>
                    <p className="text-ink-mute">{serverPlan.summary}</p>
                    {serverPlan.warnings.map((w) => (
                      <p key={w} className="text-warn">
                        {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            <ActionConfirm
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              actionId="project.updateManifest"
              /*
               * SEAM (S2, next wave): once project.updateManifest accepts
               * `expectedHash`, send the hash of the manifest this text was
               * loaded from so a save that raced another writer is refused
               * instead of overwriting them. The banner above already covers
               * the case this page can see; the hash covers the one it cannot.
               */
              input={parse.kind === "ok" ? { manifest: parse.manifest } : undefined}
              scope={{ projectId }}
              title="Save manifest source"
              description="Replaces the working copy. Nothing deploys until you review and apply the pending changes."
              confirmLabel="Save changes"
              danger={Boolean(changeset?.items.some((i) => i.risk === "high"))}
              onDone={(result) => {
                if (result.ok) {
                  setConfirmOpen(false);
                  setMovedWhileEditing(false);
                  setMode("read");
                  refresh();
                }
              }}
            />
          </div>
        </EditorBoundary>
      )}
    </div>
  );
}

/** The gutter as one text node, with the failing line marked. */
function gutterRows(lineCount: number, errLine: number | undefined) {
  const rows = Math.min(lineCount, MAX_GUTTER_LINES);
  const range = (from: number, to: number) => {
    let s = "";
    for (let i = from; i <= to; i++) s += (i > from ? "\n" : "") + i;
    return s;
  };
  if (!errLine || errLine > rows) return range(1, rows);
  return (
    <>
      {errLine > 1 ? `${range(1, errLine - 1)}\n` : ""}
      <span className="font-medium text-err">{errLine}</span>
      {errLine < rows ? `\n${range(errLine + 1, rows)}` : ""}
    </>
  );
}

/** One quiet line so the debounced check is never a silent state change. */
function ParseStatus({ parse }: { parse: ParseState }) {
  const text =
    parse.kind === "checking"
      ? "Checking…"
      : parse.kind === "ok" && !parse.issues.some((i) => i.level === "error")
        ? "Checked · parses"
        : "";
  return (
    <span role="status" className="text-[12.5px] text-ink-faint">
      {text}
    </span>
  );
}

function GoToLine({
  site,
  onGo,
}: {
  site: JsonErrorSite;
  onGo: (site: JsonErrorSite) => void;
}) {
  return (
    <Button size="sm" variant="quiet" onClick={() => onGo(site)}>
      Go to line {site.line}, column {site.column}
    </Button>
  );
}

function IssueList({ issues, slug }: { issues: ValidationIssue[]; slug: string }) {
  if (issues.length === 0)
    return (
      <div className="rounded-card border border-ok/30 bg-ok-dim px-4 py-3 text-[13px] text-ink">
        Valid manifest — schema and structure both check out.
      </div>
    );
  return (
    <Card title={`${issues.length} issue${issues.length === 1 ? "" : "s"}`} padded={false}>
      <ul>
        {issues.map((i, idx) => (
          <li
            key={idx}
            className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
          >
            <AlertTriangle
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${i.level === "error" ? "text-err" : "text-warn"}`}
            />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">{i.message}</p>
              {i.fix && <p className="mt-0.5 text-[12.5px] text-ink-mute">{i.fix}</p>}
              {i.nodeId && (
                <Link
                  href={`/p/${slug}?select=${encodeURIComponent(i.nodeId)}`}
                  className="mt-0.5 inline-block font-mono text-[11.5px] text-signal hover:underline"
                  title="Open this node on the System map"
                >
                  {i.nodeId} — show on map
                </Link>
              )}
            </div>
            <Chip tone={i.level === "error" ? "err" : "warn"} className="ml-auto shrink-0">
              {i.level}
            </Chip>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------- deployed -------------------------------- */

function DeployedTab({
  revisions,
  deployedRevisionId,
  envName,
  working,
}: {
  revisions: RevisionMeta[];
  deployedRevisionId: string | undefined;
  envName: string | undefined;
  working: Manifest;
}) {
  const [chosen, setChosen] = useState(deployedRevisionId ?? revisions[0]?.id ?? "");
  const loaded = useJson<{ revision: Revision }>(chosen ? `/api/revisions/${chosen}` : null);
  const revision = loaded.data?.revision;

  // What the working copy would change if it were deployed here right now.
  const drift = useMemo(
    () => (revision ? diffManifests(revision.manifest, working) : undefined),
    [revision, working]
  );

  if (revisions.length === 0)
    return (
      <EmptyState
        icon={<FileJson className="h-5 w-5" />}
        title={`${envName ?? "This environment"} has never been deployed`}
        body="Once a revision is live here, its exact manifest shows up for comparison against the working copy."
      />
    );

  const where = envName ?? "this environment";
  const isLive = !!deployedRevisionId && chosen === deployedRevisionId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-[280px]"
          aria-label="Revision to show"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          options={revisions.map((r) => ({
            value: r.id,
            label: `r${r.number}${r.id === deployedRevisionId ? " · live here" : ""} — ${r.message}`,
          }))}
        />
        <Chip tone={isLive ? "signal" : "neutral"}>
          {isLive ? `live in ${where}` : "not running here"}
        </Chip>
        {revision && (
          <span className="text-[12.5px] text-ink-mute">
            {revision.message}
            <span className="text-ink-faint"> · {revision.author.name}</span>
          </span>
        )}
      </div>

      {!deployedRevisionId && (
        <p className="text-[12.5px] text-ink-mute">
          {where} has never been deployed — nothing below is running there. This is the recorded
          revision, shown for comparison.
        </p>
      )}

      {loaded.error ? <ErrorNote error={loaded.error} /> : null}
      {!revision || !drift ? (
        loaded.error ? null : (
          <Skeleton height={360} />
        )
      ) : (
        <>
          <Card
            title={
              drift.items.length === 0
                ? `The working copy matches r${revision.number}`
                : `${drift.items.length} change${drift.items.length === 1 ? "" : "s"} in the working copy, not in r${revision.number}`
            }
            subtitle={
              drift.items.length === 0
                ? `r${revision.number} and the working copy describe the same system.`
                : `Deploying the working copy ${isLive ? `to ${where}` : "over this revision"} would apply these. Projected ${fmtUsd(drift.projectedMonthlyUsd)}/month afterwards (estimate).`
            }
            actions={
              drift.items.length > 0 ? <CostDelta usd={drift.totalCostDeltaUsd} /> : undefined
            }
            padded={drift.items.length === 0}
          >
            {drift.items.length === 0 ? null : (
              <ul className="-mx-1">
                {drift.items.map((i) => (
                  <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} />
                ))}
              </ul>
            )}
          </Card>

          <CodeBlock
            code={JSON.stringify(revision.manifest, null, 2)}
            title={`r${revision.number}${isLive ? ` — live in ${where}` : ""}`}
            lineNumbers
            maxHeight={560}
          />
        </>
      )}
    </div>
  );
}
