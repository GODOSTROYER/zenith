"use client";
/**
 * The map's chrome: add, connect, import, find, and which columns are drawn.
 * Top-left, never under the toasts or the zoom controls. Every group wraps on
 * its own so a 375px screen stacks them instead of pushing Connect off the edge.
 *
 * Presentational: it holds no map state, it only reports what was pressed.
 */
import type { RefObject } from "react";
import { Database, FileUp, Globe, Layers, Link2, Plus, Search, Sparkles } from "lucide-react";
import { Button, Chip, Input, Kbd } from "@/components/ui";
import type { Stratum } from "./layout";

/** Keyboard order across the map: left column to right, top to bottom. */
export const STRATA_ORDER: Stratum[] = ["route", "service", "resource"];

export const STRATUM_LABEL: Record<Stratum, string> = {
  route: "Routes",
  service: "Services",
  resource: "Resources",
};

export interface MapToolbarProps {
  empty: boolean;
  binding: boolean;
  /** name of the node a connection is being drawn from, when there is one */
  bindFromName: string | null;
  /** how many nodes the map is drawing right now */
  nodeCount: number;
  /** everything in the working system — two of anything makes Connect usable */
  nodeTotal: number;
  hidden: Stratum[];
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  /** null when nothing is being searched for */
  matchCount: number | null;
  simulatedHealth: boolean;
  onAdd: (kind: "add-service" | "add-resource" | "add-route") => void;
  onOpenDialog: (kind: "blueprint" | "compose") => void;
  onToggleBinding: () => void;
  onQueryChange: (value: string) => void;
  onSearchSubmit: () => void;
  onToggleStratum: (stratum: Stratum) => void;
}

export function MapToolbar({
  empty,
  binding,
  bindFromName,
  nodeCount,
  nodeTotal,
  hidden,
  query,
  searchRef,
  matchCount,
  simulatedHealth,
  onAdd,
  onOpenDialog,
  onToggleBinding,
  onQueryChange,
  onSearchSubmit,
  onToggleStratum,
}: MapToolbarProps) {
  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-card border border-line bg-bg2 p-1 shadow-card">
        {!binding && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => onAdd("add-service")}
            >
              Service
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Database className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => onAdd("add-resource")}
            >
              Resource
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => onAdd("add-route")}
            >
              Route
            </Button>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
          </>
        )}
        <Button
          size="sm"
          variant={binding ? "primary" : "ghost"}
          aria-pressed={binding}
          icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
          disabled={!binding && nodeTotal < 2}
          disabledReason="Connecting needs two nodes — add another one first."
          onClick={onToggleBinding}
        >
          {binding ? "Cancel" : "Connect"}
        </Button>
        {/* Importing and blueprints used to exist only in the empty state,
            so a project with one service had no way back to either. */}
        {!binding && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<FileUp className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => onOpenDialog("compose")}
            >
              Import
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => onOpenDialog("blueprint")}
            >
              Blueprint
            </Button>
          </>
        )}
      </div>

      {!empty && !binding && (
        <>
          <div className="pointer-events-auto w-44 max-w-[45vw]">
            <Input
              ref={searchRef}
              value={query}
              aria-label="Find a node by name"
              placeholder="Find a node"
              className="bg-bg2 shadow-card"
              prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
              suffix={query ? undefined : <Kbd>/</Kbd>}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onQueryChange("");
                  searchRef.current?.blur();
                  return;
                }
                if (e.key !== "Enter") return;
                e.preventDefault();
                onSearchSubmit();
              }}
            />
          </div>

          <div
            role="group"
            aria-label="Show or hide columns"
            className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-card border border-line bg-bg2 p-1 shadow-card"
          >
            <Layers className="mx-1 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            {STRATA_ORDER.map((s) => {
              const on = !hidden.includes(s);
              return (
                <Button
                  key={s}
                  size="sm"
                  variant={on ? "ghost" : "quiet"}
                  aria-pressed={on}
                  title={on ? `Hide the ${STRATUM_LABEL[s]} column` : `Show the ${STRATUM_LABEL[s]} column`}
                  onClick={() => onToggleStratum(s)}
                  className={on ? undefined : "line-through opacity-70"}
                >
                  {STRATUM_LABEL[s]}
                </Button>
              );
            })}
          </div>
        </>
      )}

      {binding && (
        <div
          role="status"
          className="animate-enter pointer-events-auto mx-auto flex items-center gap-3 rounded-full border border-signal/40 bg-bg3 px-4 py-1.5 shadow-overlay"
        >
          <span className="text-[12.5px] text-ink">
            {bindFromName
              ? `From ${bindFromName} — now pick what it uses.`
              : "Pick a source, then a target."}
          </span>
          <span className="text-[12px] text-ink-faint">
            <Kbd>Esc</Kbd> cancels
          </span>
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {matchCount !== null && (
          <Chip
            className="pointer-events-auto"
            tone={matchCount === 0 ? "warn" : "signal"}
          >
            {matchCount === 0
              ? `nothing matches "${query.trim()}"`
              : `${matchCount} of ${nodeCount} match`}
          </Chip>
        )}
        {hidden.length > 0 && (
          <Chip
            className="pointer-events-auto"
            tone="warn"
            title="Hidden columns are a view only — the working system still contains them, and the Changes panel still lists them."
          >
            {hidden.map((s) => STRATUM_LABEL[s].toLowerCase()).join(" and ")} hidden
          </Chip>
        )}
        {simulatedHealth && (
          <Chip className="pointer-events-auto" title="Health here is computed by the sandbox provider, not measured against real infrastructure.">
            simulated health
          </Chip>
        )}
      </div>
    </div>
  );
}
