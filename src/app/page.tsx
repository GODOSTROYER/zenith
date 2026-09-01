/**
 * The Orrery landing page — the front door.
 * Direction: "The Map Assembles" (see contract comment in the markup).
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
export const dynamic = "force-dynamic";

const CONTRACT = `<!--
THESIS: The product demo IS the hero — the system map assembles, prices, deploys
and goes Live in front of you; refuses the static-hero + feature-grid default.
OWN-WORLD: Orrery observatory — #0a0d13 ground, hairline structure, mint signal,
periwinkle reserved for Navigator, Space Grotesk display, JetBrains Mono for data.
STORY: visitor sees a real system come alive, understands one-model/plan-first/
honesty in the product's own vocabulary, and opens Orrery.
FIRST VIEWPORT: left column — display headline, sub, primary CTA, live narration
caption; right 60% — the assembling canvas at full bleed; nothing else.
FORM: The Map Assembles — rank 1 of 7, surface roll dealt 3/7/5, chosen as pick.
FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance
-->`;

export default async function LandingPage() {
  await ensureBoot();
  const hasWorkspace = db().workspaces.length > 0;
  const signedIn = isSupabaseConfigured() ? Boolean(await getSessionUser()) : null;
  const providers: ProviderRow[] = [...providerRegistry().values()].map((p) => ({
    id: p.id,
    displayName: p.displayName,
    availability: p.availability,
    tagline: p.tagline,
  }));

  return (
    <>
      <div hidden aria-hidden="true" dangerouslySetInnerHTML={{ __html: CONTRACT }} />
      <Landing hasWorkspace={hasWorkspace} providers={providers} signedIn={signedIn} />
    </>
  );
}
