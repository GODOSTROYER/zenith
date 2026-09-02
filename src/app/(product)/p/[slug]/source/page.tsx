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
import { AlertTriangle, FileJson, Info } from "lucide-react";
import { useJson } from "@/lib/client/api";
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
  SegmentedControl,
  Skeleton,
  Tabs,
} from "@/components/ui";
import { EditorBoundary } from "@/components/screens/editor-boundary";
import { ExportPanel } from "@/components/screens/export-panel";
import { ActionConfirm, ChangeRow, ErrorNote } from "@/components/screens/shared";
import { useSelectedEnv } from "@/components/screens/project-data";
import { describeJsonError, type JsonErrorSite } from "./json-error";

const SAVE_NOTE =
  "Save validates the text, previews the resulting changes with their cost, and only then replaces the working copy — through the same audited action every other editor uses.";

/** Idle time before the editor checks the document on its own. */
const VALIDATE_DEBOUNCE_MS = 400;

type ParseState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "error"; message: string; site?: JsonErrorSite }
  | { kind: "ok"; manifest: Manifest; issues: ValidationIssue[] };

export default function SourcePage() {
  const { data, env, projectId, refresh } = useSelectedEnv();
  const [tab, setTab] = useState("working");

  const working = data?.project.workingManifest;
  const workingJson = useMemo(
    () => (working ? JSON.stringify(working, null, 2) : ""),
    [working]
  );

  const deployed = useJson<{ revision: Revision }>(
    env?.deployedRevisionId ? `/api/revisions/${env.deployedRevisionId}` : null
  );

  if (!data || !working)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  const deployedLabel = deployed.data
    ? `Deployed (r${deployed.data.revision.number})`
    : env?.deployedRevisionId
      ? "Deployed"
      : "Deployed (none)";

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1100px] px-6 py-6">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "working", label: "Working copy" },
          { value: "deployed", label: deployedLabel },
          { value: "export", label: "Export" },
        ]}
      />

      <div className="mt-5">
        {tab === "working" && (
          <WorkingTab
            json={workingJson}
            manifest={working}
            projectId={projectId}
            refresh={refresh}
          />
        )}

        {tab === "deployed" && (
          <DeployedTab
            revision={deployed.data?.revision}
            loading={deployed.loading}
            error={deployed.error}
            neverDeployed={!env?.deployedRevisionId}
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
  json,
  manifest,
  projectId,
  refresh,
}: {
  json: string;
  manifest: Manifest;
  projectId: string;
  refresh: () => void;
}) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [text, setText] = useState(json);
  const [parse, setParse] = useState<ParseState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // The working copy can change under us (map edits, Navigator runs).
  useEffect(() => {
    setText(json);
  }, [json]);

  const dirty = text !== json;

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
    setParse({ kind: "ok", manifest: parsed.data, issues: validateManifest(parsed.data) });
  }, []);

  // Validate while the operator is idle, so Save's state is usually already
  // known by the time they reach for it. The button below is still explicit.
  useEffect(() => {
    setParse({ kind: "checking" });
    const t = setTimeout(() => validate(text), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, validate]);

  const changeset =
    parse.kind === "ok" ? diffManifests(manifest, parse.manifest) : undefined;
  const blockingIssues =
    parse.kind === "ok" && parse.issues.some((i) => i.level === "error");

  /** Select the offending character and put its line on screen. */
  const revealSite = (site: JsonErrorSite) => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(site.offset, Math.min(site.offset + 1, area.value.length));
    // Measured, not assumed: the gutter row is exactly the text row.
    const row = gutterRef.current?.children[site.line - 1] as HTMLElement | undefined;
    if (row) area.scrollTop = Math.max(0, row.offsetTop - area.clientHeight / 3);
  };

  const saveBlockedReason = !dirty
    ? "Nothing to save — the text matches the working copy."
    : parse.kind === "checking" || parse.kind === "idle"
      ? "Checking the JSON — this settles in a moment."
      : parse.kind === "error"
        ? "The document does not parse — fix the error shown below."
        : blockingIssues
          ? "Fix the validation errors first; they would block the next deploy."
          : undefined;

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
          {json.split("\n").length} lines · {manifest.services.length} services ·{" "}
          {manifest.resources.length} resources · {manifest.bindings.length} bindings
        </p>
      </div>

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
              purpose. The gutter is a plain column scrolled from the
              textarea's own scroll event; `wrap="off"` is what keeps the two
              in step, since a soft-wrapped line would take two rows in the
              textarea and one in the gutter.
            */}
            <div className="flex h-[520px] overflow-hidden rounded-card border border-line bg-bg1 focus-within:border-signal">
              <div
                ref={gutterRef}
                aria-hidden="true"
                className="tnum shrink-0 overflow-hidden border-r border-line bg-bg1 py-3 pr-2 pl-3 text-right font-mono text-[13px] leading-[1.65] text-ink-faint select-none"
              >
                {Array.from({ length: text.split("\n").length }, (_, i) => (
                  <div
                    key={i}
                    className={
                      parse.kind === "error" && parse.site?.line === i + 1
                        ? "font-medium text-err"
                        : undefined
                    }
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
              <textarea
                ref={areaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onScroll={(e) => {
                  if (gutterRef.current)
                    gutterRef.current.scrollTop = e.currentTarget.scrollTop;
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
                disabled={Boolean(saveBlockedReason)}
                disabledReason={saveBlockedReason}
                onClick={() => setConfirmOpen(true)}
              >
                Save
              </Button>
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

            <div className="flex gap-2.5 rounded-card border border-line bg-bg1 px-4 py-3 text-[12.5px] text-ink-mute">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
              <p>{SAVE_NOTE}</p>
            </div>

            {parse.kind === "error" && (
              <div className="space-y-2">
                <ErrorNote error={new Error(parse.message)} />
                {parse.site ? <GoToLine site={parse.site} onGo={revealSite} /> : null}
              </div>
            )}

            {parse.kind === "ok" && <IssueList issues={parse.issues} />}

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
                    : `Projected ${fmtUsd(changeset.projectedMonthlyUsd)}/month after these changes (estimate).`
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

            <ActionConfirm
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              actionId="project.updateManifest"
              input={parse.kind === "ok" ? { manifest: parse.manifest } : undefined}
              scope={{ projectId }}
              title="Save manifest source"
              description="Replaces the working copy. Nothing deploys until you review and apply the pending changes."
              confirmLabel="Save changes"
              danger={Boolean(changeset?.items.some((i) => i.risk === "high"))}
              onDone={(result) => {
                if (result.ok) {
                  setConfirmOpen(false);
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

/** One quiet line so the debounced check is never a silent state change. */
function ParseStatus({ parse }: { parse: ParseState }) {
  if (parse.kind === "checking")
    return <span className="text-[12.5px] text-ink-faint">Checking…</span>;
  if (parse.kind === "ok" && !parse.issues.some((i) => i.level === "error"))
    return <span className="text-[12.5px] text-ink-faint">Checked · parses</span>;
  return null;
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

function IssueList({ issues }: { issues: ValidationIssue[] }) {
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
                <p className="mt-0.5 font-mono text-[11.5px] text-ink-faint">{i.nodeId}</p>
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
  revision,
  loading,
  error,
  neverDeployed,
  envName,
  working,
}: {
  revision: Revision | undefined;
  loading: boolean;
  error: unknown;
  neverDeployed: boolean;
  envName: string | undefined;
  working: Manifest;
}) {
  // What the working copy would change if it were deployed here right now.
  const drift = useMemo(
    () => (revision ? diffManifests(revision.manifest, working) : undefined),
    [revision, working]
  );

  if (neverDeployed)
    return (
      <EmptyState
        icon={<FileJson className="h-5 w-5" />}
        title={`${envName ?? "This environment"} has never been deployed`}
        body="Once a revision is live here, its exact manifest shows up for comparison against the working copy."
      />
    );
  if (error) return <ErrorNote error={error} />;
  if (loading || !revision || !drift) return <Skeleton height={360} />;

  const where = envName ?? "this environment";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-mute">
        <Chip tone="signal">r{revision.number}</Chip>
        <span>{revision.message}</span>
        <span className="text-ink-faint">· {revision.author.name}</span>
      </div>

      <Card
        title={
          drift.items.length === 0
            ? "The working copy matches what is running"
            : `${drift.items.length} change${drift.items.length === 1 ? "" : "s"} in the working copy, not yet in ${where}`
        }
        subtitle={
          drift.items.length === 0
            ? `Nothing to deploy: r${revision.number} and the working copy describe the same system.`
            : `Deploying the working copy to ${where} would apply these. Projected ${fmtUsd(drift.projectedMonthlyUsd)}/month afterwards (estimate).`
        }
        actions={drift.items.length > 0 ? <CostDelta usd={drift.totalCostDeltaUsd} /> : undefined}
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
        title={`r${revision.number} — live in ${where}`}
        lineNumbers
        maxHeight={560}
      />
    </div>
  );
}
