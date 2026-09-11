"use client";
/**
 * Account — the screen for the things that are yours rather than the
 * workspace's.
 *
 * Settings → Members answers "who may do what here". This answers "who am I,
 * how do I get in, and how do I leave". Nothing on this page is role-gated:
 * every one of these is something a viewer may do to their own account, and
 * the only refusal is the one that protects a workspace from losing its last
 * admin.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/screens/page-heading";
import { SectionNavigation } from "@/components/screens/section-navigation";
import { useShell } from "@/components/shell/shell-context";
import { Card } from "@/components/ui/card";
import { DisplayNameCard, EmailCard, PasswordCard } from "./account-profile";
import { IdentitiesCard } from "./account-identities";
import { ExportCard, SessionsCard } from "./account-sessions";
import { DeleteAccountCard, soleAdminBlock } from "./account-delete";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "sign-in", label: "Sign-in" },
  { id: "sessions", label: "Sessions" },
  { id: "data", label: "Your data" },
  { id: "danger", label: "Danger zone" },
];

export default function AccountPage() {
  const { boot, loading, refresh } = useShell();

  if (!boot && loading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  // Auth off is local demo mode: one local user who is in every workspace and
  // has no account anywhere to change. Saying that is more use than rendering
  // five controls that would all fail.
  if (!boot?.auth.configured || !boot.user)
    return (
      <div className="product-page mx-auto h-full w-full max-w-[1100px] overflow-y-auto">
        <PageHeading title="Account" description="Your sign-in, your sessions and your data." />
        <Card title="This server has no accounts">
          <p className="max-w-[70ch] text-[13px] text-ink-mute">
            Zenith is running in local demo mode: one local user, in every workspace, with nothing
            to sign in to. Set <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span> and the
            publishable key to turn authentication on, and this screen becomes your account.
          </p>
        </Card>
      </div>
    );

  const user = boot.user;
  // Only the current workspace's members are on the shell payload, so this
  // catches the common case early. `/api/account` re-checks every workspace,
  // and its answer is the one that decides.
  const here = boot.members.filter((m) => m.role === "admin");
  const soleAdminHere =
    boot.role === "admin" && here.length === 1 && here[0]?.id === user.id
      ? soleAdminBlock(boot.workspace.name)
      : undefined;

  return (
    <div className="product-page mx-auto h-full w-full max-w-[1100px] overflow-y-auto">
      <PageHeading
        title="Account"
        description="Your name, how you sign in, where you are signed in, and what happens if you leave."
      />

      <SectionNavigation sections={SECTIONS} label="Sections of your account" />

      <div className="space-y-10 pb-16">
        <section id="profile" tabIndex={-1} className="space-y-4">
          <DisplayNameCard currentName={user.name} onSaved={refresh} />
        </section>

        <section id="sign-in" tabIndex={-1} className="space-y-4">
          <EmailCard currentEmail={user.email} />
          <PasswordCard email={user.email} />
          <IdentitiesCard />
        </section>

        <section id="sessions" tabIndex={-1} className="space-y-4">
          <SessionsCard />
        </section>

        <section id="data" tabIndex={-1} className="space-y-4">
          <ExportCard />
        </section>

        <section id="danger" tabIndex={-1} className="space-y-4">
          <DeleteAccountCard
            email={user.email}
            workspaceCount={boot.workspaces.length || 1}
            blocked={soleAdminHere}
          />
        </section>
      </div>
    </div>
  );
}
