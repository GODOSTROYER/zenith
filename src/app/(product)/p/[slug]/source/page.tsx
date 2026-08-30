"use client";
/**
 * Source — the system as code.
 *
 * The manifest is the one model: what you read here is exactly what the map
 * draws and what a deploy snapshots. Save validates, previews the resulting
 * changes, and replaces the working copy through project.updateManifest —
 * the same audited action pipeline the visual editor uses.
 */
import { useEffect, useMemo, useState } from "react";
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

const SAVE_NOTE =
  "Save validates the text, previews the resulting changes with their cost, and only then replaces the working copy — through the same audited action every other editor uses.";

type ParseState =
  | { kind: "idle" }
  | { kind: "error"; message: string }
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

  // The working copy can change under us (map edits, Navigator runs).
  useEffect(() => {
    setText(json);
    setParse({ kind: "idle" });
  }, [json]);

  const dirty = text !== json;

  const validate = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      setParse({
        kind: "error",
        message: `${(e as Error).message}. Fix the JSON syntax — the manifest has to parse before anything can be checked.`,
      });
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
  };

  const changeset =
    parse.kind === "ok" ? diffManifests(manifest, parse.manifest) : undefined;

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
            setParse({ kind: "idle" });
          }}
        >
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              aria-label="Manifest JSON"
              className="h-[520px] w-full resize-y rounded-card border border-line bg-bg1 p-3 font-mono text-[13px] leading-[1.65] text-ink outline-none focus-visible:border-signal"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" onClick={validate}>
                Validate
              </Button>
              <Button
                disabled={
                  !dirty ||
                  parse.kind !== "ok" ||
                  parse.issues.some((i) => i.level === "error")
                }
                disabledReason={
                  !dirty
                    ? "Nothing to save — the text matches the working copy."
                    : parse.kind !== "ok"
                      ? "Validate first — Save only applies text that parses and passes checks."
                      : "Fix the validation errors first; they would block the next deploy."
                }
                onClick={() => setConfirmOpen(true)}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                disabled={!dirty}
                disabledReason="The text already matches the working copy."
                onClick={() => {
                  setText(json);
                  setParse({ kind: "idle" });
                }}
              >
                Revert
              </Button>
              {dirty && <Chip tone="warn">Unsaved text</Chip>}
            </div>

            <div className="flex gap-2.5 rounded-card border border-line bg-bg1 px-4 py-3 text-[12.5px] text-ink-mute">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
              <p>{SAVE_NOTE}</p>
            </div>

            {parse.kind === "error" && <ErrorNote error={new Error(parse.message)} />}

            {parse.kind === "ok" && (
              <IssueList issues={parse.issues} />
            )}

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
                  setParse({ kind: "idle" });
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
}: {
  revision: Revision | undefined;
  loading: boolean;
  error: unknown;
  neverDeployed: boolean;
  envName: string | undefined;
}) {
  if (neverDeployed)
    return (
      <EmptyState
        icon={<FileJson className="h-5 w-5" />}
        title={`${envName ?? "This environment"} has never been deployed`}
        body="Once a revision is live here, its exact manifest shows up for comparison against the working copy."
      />
    );
  if (error) return <ErrorNote error={error} />;
  if (loading || !revision) return <Skeleton height={360} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-mute">
        <Chip tone="signal">r{revision.number}</Chip>
        <span>{revision.message}</span>
        <span className="text-ink-faint">· {revision.author.name}</span>
      </div>
      <CodeBlock
        code={JSON.stringify(revision.manifest, null, 2)}
        title={`r${revision.number} — live in ${envName ?? "this environment"}`}
        lineNumbers
        maxHeight={560}
      />
    </div>
  );
}
