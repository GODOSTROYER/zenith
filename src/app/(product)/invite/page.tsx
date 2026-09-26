import type { Metadata } from "next";
import { InvitationPanel } from "./invitation-panel";

export const metadata: Metadata = { title: "Workspace invitation · Zenith" };

/** The product layout protects this route while preserving its invite query. */
export default async function WorkspaceInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const inviteId = typeof params.invite === "string" ? params.invite.trim() : null;

  return <InvitationPanel inviteId={inviteId || null} />;
}
