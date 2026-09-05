"use client";
/**
 * The product top bar: wordmark, palette, notifications, theme, and the two
 * chips that were static text until now.
 *
 * Both chips are menus, because both looked like controls. The user chip also
 * carries the caller's role — the value every role-gated control in the product
 * is supposed to read, and which nothing showed the person it applies to.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, LogOut, Plus, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MenuItem, MenuNote, Popover } from "@/components/ui/popover";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ActivityBell } from "@/components/shell/activity-bell";
import { CommandPalette } from "@/components/shell/command-palette";
import { useShell } from "@/components/shell/shell-context";
import { Wordmark } from "@/components/shell/wordmark";
import { api, ApiError } from "@/lib/client/api";
import { cx } from "@/lib/format";
import type { Workspace } from "@/lib/domain/types";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-bg2 px-2.5 py-0.5 text-[12px] " +
  "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)] " +
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
            className={cx(CHIP, "max-w-[180px] text-ink-mute hover:text-ink")}
          >
            <span className="truncate">{boot.workspace.name}</span>
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
          disabledReason="Orrery in demo mode runs one workspace. Configure Supabase auth for real identities and multiple workspaces."
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
          title={boot.user.email}
          onClick={() => setOpen((o) => !o)}
          className={cx(CHIP, "max-w-[220px] text-ink")}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
          <span className="truncate">{boot.user.name}</span>
          {boot.role && (
            <span className="shrink-0 text-ink-faint">
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

export function ProductChrome() {
  const { catalog } = useShell();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg1 px-4">
      <Link
        href="/overview"
        title="Workspace overview"
        className="rounded-ctl px-1 py-0.5 transition-opacity duration-[120ms] [transition-timing-function:var(--ease-swift)] hover:opacity-80"
      >
        <Wordmark />
      </Link>
      <div className="flex items-center gap-2">
        <CommandPalette catalog={catalog} />
        <ActivityBell />
        <ThemeToggle />
        <WorkspaceChip />
        <UserMenu />
      </div>
    </header>
  );
}
