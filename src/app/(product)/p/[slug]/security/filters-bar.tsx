"use client";
/**
 * What the open list is filtered and sorted by, plus the two whole-screen
 * actions: export what is loaded, and run every fix that was previewed.
 */
import { Wrench } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import type { Environment, SecurityFinding } from "@/lib/domain/types";
import { Button, SegmentedControl, Select } from "@/components/ui";
import {
  SEVERITY_ORDER,
  viewerReason,
  type EnvFilter,
  type Filters,
  type FixFilter,
  type FixSplit,
  type SeverityFilter,
  type SortKey,
} from "./rows";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "severity", label: "Highest severity first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export interface FiltersBarProps {
  open: SecurityFinding[];
  autoFixable: SecurityFinding[];
  manualOnly: number;
  environments: Environment[];
  filters: Filters;
  sort: SortKey;
  /** undefined while the fix previews are still being computed */
  planned: boolean;
  split: FixSplit;
  /** one sentence naming everything "Fix all" leaves out, when there is one */
  excluded: string | undefined;
  canEdit: boolean;
  role: Role | null;
  exportCount: number;
  onFilters: (next: (f: Filters) => Filters) => void;
  onSort: (key: SortKey) => void;
  onSave: (kind: "json" | "csv") => void;
  onFixAll: () => void;
}

export function FiltersBar({
  open,
  autoFixable,
  manualOnly,
  environments,
  filters,
  sort,
  planned,
  split,
  excluded,
  canEdit,
  role,
  exportCount,
  onFilters,
  onSort,
  onSave,
  onFixAll,
}: FiltersBarProps) {
  const exportTitle = `All ${exportCount} finding${exportCount === 1 ? "" : "s"} on this project, every status included. Written in your browser from what this page already loaded.`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl<SeverityFilter>
        size="sm"
        label="Filter by severity"
        value={filters.severity}
        onChange={(v) => onFilters((f) => ({ ...f, severity: v }))}
        options={[
          { value: "all", label: `All ${open.length}`, title: "Every open finding" },
          ...SEVERITY_ORDER.map((s) => ({
            value: s,
            label: `${s} ${open.filter((f) => f.severity === s).length}`,
            title: `${s} severity only`,
          })),
        ]}
      />
      <SegmentedControl<FixFilter>
        size="sm"
        label="Filter by whether a fix exists"
        value={filters.fix}
        onChange={(v) => onFilters((f) => ({ ...f, fix: v }))}
        options={[
          { value: "all", label: "Any fix", title: "Fixable and manual findings" },
          {
            value: "fixable",
            label: `Auto-fixable ${autoFixable.length}`,
            title: "Findings a registered action can fix",
          },
          {
            value: "manual",
            label: `Manual ${manualOnly}`,
            title: "Findings with no automatic fix — you change the system yourself",
          },
        ]}
      />
      <Select
        className="w-[190px]"
        aria-label="Filter by environment"
        value={filters.environmentId}
        onChange={(e) => onFilters((f) => ({ ...f, environmentId: e.target.value as EnvFilter }))}
        options={[
          { value: "all", label: "Any environment" },
          ...environments.map((e) => ({
            value: e.id,
            label: `${e.name} · ${open.filter((f) => f.environmentId === e.id).length}`,
          })),
          {
            value: "none",
            label: `Not environment-specific · ${open.filter((f) => !f.environmentId).length}`,
          },
        ]}
      />
      <Select
        className="w-[190px]"
        aria-label="Sort findings"
        value={sort}
        onChange={(e) => onSort(e.target.value as SortKey)}
        options={SORTS}
      />
      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="quiet" title={exportTitle} onClick={() => onSave("json")}>
            Export JSON
          </Button>
          <Button size="sm" variant="quiet" title={exportTitle} onClick={() => onSave("csv")}>
            CSV
          </Button>
        </div>
        <Button
          size="sm"
          icon={<Wrench className="h-3.5 w-3.5" />}
          disabled={
            !canEdit ||
            autoFixable.length === 0 ||
            (planned && split.runnable.length === 0)
          }
          disabledReason={
            !canEdit
              ? viewerReason("Fixing a finding", role)
              : autoFixable.length === 0
                ? `None of the ${open.length} open finding${open.length === 1 ? " has" : "s have"} an automatic fix — change the system, then dismiss each with a reason.`
                : (excluded ??
                  "None of these fixes can run right now — open one to see what its plan says.")
          }
          title="Preview every automatic fix, then run them"
          onClick={onFixAll}
        >
          Fix all {planned && canEdit ? split.runnable.length : autoFixable.length}
        </Button>
      </div>
    </div>
  );
}
