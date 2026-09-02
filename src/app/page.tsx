/**
 * The Orrery landing page — the front door.
 * Direction: "The Map Assembles" — see docs/DESIGN.md.
 * Product users pass straight through via the Open Orrery CTA; the page
 * pulls its provider table live from the registry so it can never overclaim.
 */
import type { Metadata } from "next";
import { db } from "@/lib/db/store";
import { ensureBoot } from "@/lib/server/boot";
import { providerRegistry } from "@/lib/providers/types";
import { Landing, type ProviderRow } from "@/components/landing/landing";
import { getSessionUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Orrery — your infrastructure, in motion",
  description:
    "A bring-your-own-cloud deployment platform that shows the whole system, prices every change before it applies, and ends every deploy with a URL.",
};
/** session-aware (getSessionUser) — the CTA differs for signed-in visitors */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  // registers the provider adapters the honesty table reads below
  await ensureBoot();
  const hasWorkspace = db().workspaces.length > 0;
  const signedIn = isSupabaseConfigured() ? Boolean(await getSessionUser()) : null;
  const providers: ProviderRow[] = [...providerRegistry().values()].map((p) => ({
    id: p.id,
    displayName: p.displayName,
    availability: p.availability,
    tagline: p.tagline,
  }));

  return <Landing hasWorkspace={hasWorkspace} providers={providers} signedIn={signedIn} />;
}
