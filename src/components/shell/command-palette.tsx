"use client";
/**
 * ⌘K / Ctrl-K — every screen and every registered action, in one list.
 *
 * The action rows come from the real `actionRegistry()`, serialised by the
 * product layout (a server component), so this list cannot drift from what the
 * engine will accept: the title, risk and required role shown here are the ones
 * `runAction` enforces. A row the caller's role forbids is disabled and says
 * which role it needs and which one they have, rather than sending them
 * somewhere that will refuse them.
 *
 * Actions are not executed from here — an action needs a plan-first surface and
 * a scope. Each action row navigates to the screen that owns it and says which
 * screen that is, so the row does exactly what it claims.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Kbd, RiskBadge } from "@/components/ui";
import { useModal } from "@/components/ui/use-modal";
import { useShell, type ActionEntry } from "@/components/shell/shell-context";
import { cx } from "@/lib/format";

/** Lives with the rest of the shell's data contract; re-exported for callers. */
export type { ActionEntry };

type Role = ActionEntry["requiredRole"];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** The project tab that owns each action category — where its row navigates. */
const CATEGORY_TAB: Record<string, { seg: string; label: string }> = {
  project: { seg: "settings", label: "Settings" },
  system: { seg: "", label: "System map" },
  secrets: { seg: "", label: "System map" },
  deploy: { seg: "deploys", label: "Deploys" },
  environment: { seg: "settings", label: "Settings" },
  connection: { seg: "settings", label: "Settings" },
  operations: { seg: "", label: "System map" },
  navigator: { seg: "navigator", label: "Navigator" },
};

const TABS: { seg: string; label: string }[] = [
  { seg: "", label: "System map" },
  { seg: "source", label: "Source" },
  { seg: "deploys", label: "Deploys" },
  { seg: "revisions", label: "Revisions" },
  { seg: "observe", label: "Observe" },
  { seg: "security", label: "Security" },
  { seg: "activity", label: "Activity" },
  { seg: "navigator", label: "Navigator" },
  { seg: "settings", label: "Settings" },
];

export interface PaletteRow {
  key: string;
  title: string;
  /** where it goes, in words — the row's promise */
  where: string;
  href?: string;
  group: "Screens" | "Actions";
  risk?: ActionEntry["risk"];
  /** set when the row cannot be used, and says why */
  blocked?: string;
  /** lower-cased haystack for the query */
  search: string;
}

/**
 * Pure so it can be tested without a DOM: screens first, then every action with
 * its destination and, when the role forbids it, the reason. Actions land in
 * `projects[0]`, so the caller puts the project being looked at there.
 */
export function paletteRows(
  catalog: ActionEntry[],
  projects: { name: string; slug: string }[],
  role: Role | null
): PaletteRow[] {
  const rows: PaletteRow[] = [
    {
      key: "screen:overview",
      title: "Workspace overview",
      where: "the workspace overview",
      href: "/overview",
      group: "Screens",
      search: "overview workspace home projects",
    },
    {
      key: "screen:new",
      title: "New project",
      where: "onboarding",
      href: "/onboarding?step=3",
      group: "Screens",
      search: "new project create onboarding blueprint import",
    },
  ];

  for (const p of projects)
    for (const t of TABS)
      rows.push({
        key: `screen:${p.slug}:${t.seg}`,
        title: `${p.name} — ${t.label}`,
        where: `/p/${p.slug}${t.seg ? `/${t.seg}` : ""}`,
        href: `/p/${p.slug}${t.seg ? `/${t.seg}` : ""}`,
        group: "Screens",
        search: `${p.name} ${p.slug} ${t.label}`.toLowerCase(),
      });

  const project = projects[0];
  for (const a of catalog) {
    const tab = CATEGORY_TAB[a.category] ?? { seg: "", label: "System map" };
    const blocked = !project
      ? "No project in this workspace yet — create one first."
      : role && RANK[role] < RANK[a.requiredRole]
        ? `Needs the ${a.requiredRole} role. You are ${role} in this workspace.`
        : undefined;
    rows.push({
      key: `action:${a.id}`,
      title: a.title,
      where: project ? `${project.name} — ${tab.label}` : tab.label,
      href: project ? `/p/${project.slug}${tab.seg ? `/${tab.seg}` : ""}` : undefined,
      group: "Actions",
      risk: a.risk,
      blocked,
      search: `${a.title} ${a.id} ${a.category}`.toLowerCase(),
    });
  }
  return rows;
}

/** At most this many rows are rendered; the query is how you reach the rest. */
export const PALETTE_LIMIT = 40;

export function filterRows(rows: PaletteRow[], query: string): PaletteRow[] {
  const q = query.trim().toLowerCase();
  return (q ? rows.filter((r) => r.search.includes(q)) : rows).slice(0, PALETTE_LIMIT);
}

/** Header trigger + the palette itself; one component so they share `open`. */
export function CommandPalette({ catalog }: { catalog: ActionEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [mac, setMac] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { boot } = useShell();
  const listId = useId();
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);
  const { ref, present, shown } = useModal(open, close);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAt(0);
  }, [open]);

  /** The project you are looking at goes first, so actions land where you are. */
  const projects = useMemo(() => {
    const all = boot?.projects ?? [];
    const slug = /^\/p\/([^/]+)/.exec(pathname ?? "")?.[1];
    const at = all.findIndex((p) => p.slug === slug);
    return at > 0 ? [all[at], ...all.filter((_, i) => i !== at)] : all;
  }, [boot?.projects, pathname]);

  const rows = useMemo(
    () => paletteRows(catalog, projects, boot?.role ?? null),
    [catalog, projects, boot?.role]
  );
  const results = useMemo(() => filterRows(rows, query), [rows, query]);
  const active = results[Math.min(at, results.length - 1)];

  const go = (row: PaletteRow | undefined) => {
    if (!row?.href || row.blocked) return;
    setOpen(false);
    router.push(row.href);
  };

  const hint = mac ? "⌘" : "Ctrl";

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Search screens and actions (${hint}+K)`}
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-2 rounded-ctl border border-line bg-bg2 px-2.5 text-[12.5px] text-ink-mute transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)] hover:border-line-strong hover:text-ink"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Search</span>
        <Kbd className="hidden sm:inline-flex">{mac ? "⌘K" : "Ctrl K"}</Kbd>
      </button>

      {present &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
            <div
              onClick={close}
              aria-hidden="true"
              className={cx(
                "absolute inset-0 bg-bg0/70 transition-opacity duration-200 [transition-timing-function:var(--ease-swift)]",
                shown ? "opacity-100" : "opacity-0"
              )}
            />
            <div
              ref={ref}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              className={cx(
                "relative flex max-h-[70vh] w-full max-w-[560px] flex-col overflow-hidden rounded-card border border-line bg-bg3 shadow-overlay outline-none",
                "transition-[opacity,transform] duration-200 [transition-timing-function:var(--ease-swift)]",
                shown
                  ? "translate-y-0 scale-100 opacity-100"
                  : "translate-y-1 scale-[0.98] opacity-0"
              )}
            >
              <h2 id={titleId} className="sr-only">
                Go to a screen, or to the screen that owns an action
              </h2>
              <div className="flex items-center gap-2.5 border-b border-line px-3.5">
                <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
                <input
                  value={query}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={active ? `${listId}-${active.key}` : undefined}
                  aria-autocomplete="list"
                  aria-label="Search screens and actions"
                  placeholder="Search screens and actions…"
                  spellCheck={false}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setAt(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setAt((i) => Math.min(i + 1, results.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setAt((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      go(active);
                    }
                  }}
                  className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
                />
                <Kbd>esc</Kbd>
              </div>

              <ul
                id={listId}
                role="listbox"
                aria-label="Results"
                className="min-h-0 flex-1 overflow-y-auto py-1"
              >
                {results.length === 0 && (
                  <li className="px-3.5 py-6 text-center text-[12.5px] text-ink-faint">
                    Nothing matches “{query}”. Try a screen name, an action title, or an action id.
                  </li>
                )}
                {results.map((r, i) => (
                  <li
                    key={r.key}
                    id={`${listId}-${r.key}`}
                    role="option"
                    aria-selected={r === active}
                    aria-disabled={r.blocked ? true : undefined}
                    title={r.blocked}
                    onMouseEnter={() => setAt(i)}
                    onClick={() => go(r)}
                    className={cx(
                      "mx-1 flex items-center gap-3 rounded-ctl px-2.5 py-2",
                      r === active && "bg-bg2",
                      r.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{r.title}</span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                        {r.blocked ?? `Opens ${r.where}`}
                      </span>
                    </span>
                    {r.risk && <RiskBadge level={r.risk} />}
                    <span className="shrink-0 text-[10.5px] tracking-[0.02em] text-ink-faint uppercase">
                      {r.group}
                    </span>
                  </li>
                ))}
              </ul>

              <footer className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-faint">
                <span className="inline-flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> move
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>↵</Kbd> open
                </span>
                <span className="ml-auto inline-flex items-center gap-1">
                  <Kbd>{hint}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </footer>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
