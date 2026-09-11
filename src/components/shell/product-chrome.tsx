"use client";
/**
 * Persistent navigation and one context bar. Workspace/account menus retain
 * real membership and action semantics; the project supplies its controls
 * through a DOM slot without lifting or duplicating the project data spine.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MenuItem, MenuNote, Popover } from "@/components/ui/popover";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ActivityBell } from "@/components/shell/activity-bell";
import { CommandPalette } from "@/components/shell/command-palette";
import { useShell } from "@/components/shell/shell-context";
import { OrbitMark, Wordmark } from "@/components/shell/wordmark";
import { ChromeSlotContext } from "./chrome-slot";
import { ShellNavigation } from "./navigation";
import { api, ApiError } from "@/lib/client/api";
import { cx } from "@/lib/format";
import type { Workspace } from "@/lib/domain/types";

const CHIP =
  "inline-flex min-h-9 items-center gap-2 rounded-ctl border border-transparent px-2 py-1 text-[13px] " +
  "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)] " +
  "hover:border-line-strong focus-visible:border-signal";

/** Where the workspace's own settings live — under whichever project is open. */
function useSettingsSlug(): string | undefined {
  const pathname = usePathname();
  const { boot } = useShell();
  return /^\/p\/([^/]+)/.exec(pathname ?? "")?.[1] ?? boot?.projects[0]?.slug;
}

/**
 * Name a new workspace and enter it. `workspace.create` is a route, not an
 * action, because it happens before the membership an action would role-check.
 */
function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useShell();
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // The route selects what it creates, so the next render lands inside it.
      await api<{ workspace: Workspace }>("/api/workspace", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setName("");
      onClose();
      refresh();
      router.push("/overview");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create workspace"
      description="A separate set of projects, connections, members and history. Nothing is shared with the one you are in."
      width={420}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            disabledReason="Give the workspace a name first."
            onClick={submit}
          >
            Create and switch
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !busy) void submit();
        }}
      >
        <Field label="Name" help="You can rename it later from Settings.">
          <Input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Kepler Labs"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {error && (
          <Callout tone="err" className="mt-3" compact title={error.message}>
            {error.fix}
          </Callout>
        )}
      </form>
    </Dialog>
  );
}

function WorkspaceChip() {
  const { boot, refresh } = useShell();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switchError, setSwitchError] = useState<string>();
  const close = useCallback(() => setOpen(false), []);
  const slug = useSettingsSlug();

  const select = async (workspaceId: string) => {
    close();
    setSwitchError(undefined);
    try {
      await api("/api/workspace/select", { method: "POST", body: JSON.stringify({ workspaceId }) });
      refresh();
      router.push("/overview");
      router.refresh();
    } catch (err) {
      setSwitchError(err instanceof ApiError ? (err.fix ?? err.message) : String(err));
    }
  };

  if (!boot?.workspace)
    return <span className="h-6 w-24 animate-pulse rounded-full bg-bg2" aria-hidden="true" />;

  const settings = slug ? `/p/${slug}/settings` : undefined;
  const noProject = "Workspace settings live under a project, and this workspace has none yet.";
  // Demo mode has one local user who is admin of everything, so a second
  // workspace would only be a second name for the same permissions.
  const canCreate = boot.auth.configured;
  const others = boot.workspaces.filter((w) => w.id !== boot.workspace.id);

  return (
    <>
      <Popover
        open={open}
        onClose={close}
        label={`Workspace ${boot.workspace.name}`}
        width={264}
        trigger={
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            title={`Workspace · ${boot.workspace.name}`}
            onClick={() => setOpen((o) => !o)}
            className={cx(CHIP, "workbench-workspace-picker w-full min-w-0 justify-between text-ink-mute hover:text-ink")}
          >
            <span className="truncate">{boot.workspace.name}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
          </button>
        }
      >
        <MenuNote>
          {boot.role
            ? `You are ${boot.role} in this workspace.`
            : "Your role in this workspace is not known yet."}
          {switchError && (
            <>
              <br />
              <span className="text-err">{switchError}</span>
            </>
          )}
        </MenuNote>

        {/* The one you are in is marked, not hidden: a switcher that omits the
            current row makes you count to work out where you are. */}
        <MenuItem
          icon={<Check className="h-3.5 w-3.5 text-signal" aria-hidden="true" />}
          hint={boot.role ?? undefined}
          onClick={close}
          className="font-medium"
        >
          {boot.workspace.name}
        </MenuItem>
        {others.map((w) => (
          <MenuItem
            key={w.id}
            icon={<span className="block h-3.5 w-3.5" aria-hidden="true" />}
            hint={w.role}
            onClick={() => void select(w.id)}
          >
            {w.name}
          </MenuItem>
        ))}
        <MenuItem
          icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          onClick={() => {
            close();
            setCreating(true);
          }}
          disabled={!canCreate}
          disabledReason="Zenith in demo mode runs one workspace. Configure Supabase auth for real identities and multiple workspaces."
        >
          Create workspace…
        </MenuItem>

        <div className="my-1 border-t border-line" role="none" />
        <MenuItem
          href={settings}
          onClick={close}
          icon={<Settings className="h-3.5 w-3.5" aria-hidden="true" />}
          description="Name, environments, connections"
          disabled={!settings}
          disabledReason={noProject}
        >
          Rename workspace
        </MenuItem>
        <MenuItem
          href={settings ? `${settings}#members` : undefined}
          onClick={close}
          icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />}
          hint={boot.members.length || undefined}
          description="Who can do what here"
          disabled={!settings}
          disabledReason={noProject}
        >
          Members and roles
        </MenuItem>
      </Popover>
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/** Who's signed in, their role, and the way out. Hidden in demo mode. */
function UserMenu() {
  const { boot } = useShell();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!boot?.auth.configured) return null;
  if (!boot.user)
    return (
      <Link href="/login" className="text-[12.5px] text-ink-mute transition-colors hover:text-ink">
        Sign in
      </Link>
    );

  return (
    <Popover
      open={open}
      onClose={close}
      label={`Account ${boot.user.name}`}
      width={248}
      trigger={
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Account: ${boot.user.name}, ${boot.role ?? "member"}`}
          title={boot.user.email}
          onClick={() => setOpen((o) => !o)}
          className={cx(CHIP, "max-w-[200px] text-ink")}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
          <span className="truncate">{boot.user.name}</span>
          {boot.role && (
            <span className="hidden shrink-0 text-ink-faint md:inline">
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, role </span>
              {boot.role}
            </span>
          )}
        </button>
      }
    >
      <MenuNote>
        {boot.user.email}
        <br />
        {boot.role
          ? `${boot.role} in ${boot.workspace?.name ?? "this workspace"} — what every permission check reads.`
          : "No role in this workspace yet."}
      </MenuNote>
      {/* A POST form, so signing out works with or without JavaScript.
          role="none" keeps the menu's children menuitems as far as AT sees. */}
      <form action="/auth/signout" method="post" role="none">
        <MenuItem
          type="submit"
          icon={<LogOut className="h-3.5 w-3.5" aria-hidden="true" />}
          description={boot.user.email}
        >
          Sign out
        </MenuItem>
      </form>
    </Popover>
  );
}

export function ProductChrome({ children }: { children: ReactNode }) {
  const { catalog, boot } = useShell();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const routeSlug = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  const slug = routeSlug ?? boot?.projects[0]?.slug;
  const projectName = boot?.projects.find((project) => project.slug === slug)?.name;
  const title = pathname.startsWith("/guide") ? "Workspace guide" : "Workspace overview";

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("zenith-shell-collapsed") === "true"); } catch { /* Optional preference. */ }
  }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const onWide = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener("change", onWide);
    return () => media.removeEventListener("change", onWide);
  }, []);
  const toggleRail = () => setCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem("zenith-shell-collapsed", String(next)); } catch { /* Session state remains usable. */ }
    return next;
  });

  return (
    <ChromeSlotContext.Provider value={slot}>
      <div className="workbench-frame" data-collapsed={collapsed}>
        <aside className="workbench-rail" aria-label="Workspace navigation">
          <Link href="/overview" className="workbench-brand" aria-label="Zenith workspace overview">
            {collapsed ? <OrbitMark size={27} /> : <Wordmark size={26} />}
          </Link>
          {!collapsed && <div className="workbench-workspace"><WorkspaceChip /></div>}
          {collapsed && <div className="workbench-workspace-compact"><WorkspaceChip /></div>}
          <div className="workbench-nav-scroll"><ShellNavigation pathname={pathname} slug={slug} projectName={projectName} collapsed={collapsed} /></div>
          <div className="workbench-rail-footer">
            <button type="button" className="workbench-nav-link" onClick={toggleRail}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed}>
              {collapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
              <span className={collapsed ? "sr-only" : "workbench-nav-label"}>Collapse navigation</span>
            </button>
          </div>
        </aside>
        <div className="workbench-body">
          <header className="workbench-context-bar">
            <button type="button" className="workbench-mobile-menu" onClick={() => setMobileOpen(true)}
              aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={mobileOpen}>
              <Menu size={20} aria-hidden="true" />
            </button>
            <div className="workbench-context" ref={setSlot} />
            {!routeSlug && <div className="workbench-context-title">{title}</div>}
            <div className="workbench-tools">
              <CommandPalette catalog={catalog} />
              <ActivityBell />
              <span className="workbench-desktop-theme"><ThemeToggle /></span>
              <span className="workbench-account"><UserMenu /></span>
            </div>
          </header>
          {children}
        </div>
        <Drawer open={mobileOpen} onClose={closeMobile} title={<Wordmark size={24} />} description="Workspace and project navigation" width={420}>
          <div className="workbench-mobile-workspace"><WorkspaceChip /></div>
          <ShellNavigation pathname={pathname} slug={slug} projectName={projectName} onNavigate={closeMobile} />
          <div className="workbench-mobile-footer"><ThemeToggle /><UserMenu /></div>
        </Drawer>
      </div>
    </ChromeSlotContext.Provider>
  );
}
