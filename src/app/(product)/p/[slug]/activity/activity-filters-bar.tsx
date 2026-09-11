"use client";
/**
 * What the trail is narrowed by. Actor, action and result are query
 * parameters — they reach back through the whole log. Search and the date
 * range only see what is loaded, and the copy under them says so.
 */
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";

export type ActorFilter = "all" | "user" | "navigator" | "system";
export type ResultFilter = "all" | "ok" | "error" | "denied";

/** Action prefixes worth filtering by; the endpoint takes any `prefix.` form. */
const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "deploy.", label: "Deploys" },
  { value: "system.", label: "System edits" },
  { value: "project.", label: "Project" },
  { value: "env.", label: "Environments" },
  { value: "connection.", label: "Connections" },
  { value: "security.", label: "Security" },
  { value: "ops.", label: "Operations" },
  { value: "workspace.", label: "Workspace" },
  { value: "navigator.", label: "Navigator runs" },
];

export const ACTOR_LABEL: Record<ActorFilter, string> = {
  all: "everyone",
  user: "people",
  navigator: "the Navigator",
  system: "the system",
};

export interface ActivityFiltersProps {
  query: string;
  actor: ActorFilter;
  action: string;
  result: ResultFilter;
  from: string;
  to: string;
  /** how many actions are loaded — the date note is honest about its reach */
  loadedCount: number;
  onQuery: (value: string) => void;
  onActor: (value: ActorFilter) => void;
  onAction: (value: string) => void;
  onResult: (value: ResultFilter) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onClearDates: () => void;
}

export function ActivityFilters({
  query,
  actor,
  action,
  result,
  from,
  to,
  loadedCount,
  onQuery,
  onActor,
  onAction,
  onResult,
  onFrom,
  onTo,
  onClearDates,
}: ActivityFiltersProps) {
  return (
    <section aria-label="Filter activity" className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="min-w-[180px] flex-1"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search loaded actions…"
          aria-label="Search loaded actions"
          prefix={<Search className="h-3.5 w-3.5" />}
        />
        <SegmentedControl<ActorFilter>
          size="sm"
          label="Filter by who acted"
          value={actor}
          onChange={onActor}
          options={[
            { value: "all", label: "Everyone" },
            { value: "user", label: "People", title: "Actions a person ran" },
            { value: "navigator", label: "Navigator", title: "Actions the agent ran" },
            { value: "system", label: "System", title: "Actions the platform ran itself" },
          ]}
        />
        <Select
          className="w-[150px]"
          aria-label="Filter by action"
          value={action}
          onChange={(e) => onAction(e.target.value)}
          options={ACTION_OPTIONS}
        />
        <Select
          className="w-[130px]"
          aria-label="Filter by result"
          value={result}
          onChange={(e) => onResult(e.target.value as ResultFilter)}
          options={[
            { value: "all", label: "Any result" },
            { value: "ok", label: "Succeeded" },
            { value: "error", label: "Failed" },
            { value: "denied", label: "Refused" },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-mute">
        <span className="mr-1">Loaded date range</span>
        <Input
          type="date"
          className="w-[145px]"
          aria-label="Only actions on or after this date"
          value={from}
          max={to || undefined}
          onChange={(e) => onFrom(e.target.value)}
        />
        <span>to</span>
        <Input
          type="date"
          className="w-[145px]"
          aria-label="Only actions on or before this date"
          value={to}
          min={from || undefined}
          onChange={(e) => onTo(e.target.value)}
        />
        {(from || to) && (
          <>
            <Button size="sm" variant="ghost" onClick={onClearDates}>
              Clear dates
            </Button>
            <span className="text-ink-faint">
              Dates narrow the {loadedCount} actions loaded here, not the whole trail.
            </span>
          </>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-ink-mute">Actor, action and result filters search the full trail. Search and dates narrow the {loadedCount} loaded actions. Environment filtering is not available.</p>
    </section>
  );
}
