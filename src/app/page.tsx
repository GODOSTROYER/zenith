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

const TITLE = "Orrery — your infrastructure, in motion";
const DESCRIPTION =
  "A bring-your-own-cloud deployment platform that shows the whole system, prices every change before it applies, and ends every deploy with a URL.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Absolute-URL base for the generated social card (see opengraph-image.tsx).
  // Set NEXT_PUBLIC_SITE_URL wherever this is deployed.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3400"),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Orrery",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};
/**
 * Session-aware (getSessionUser) and workspace-aware (db()), and both feed the
 * page's primary CTA — so the shell cannot be cached separately without either
 * a lite session endpoint (none exists; /api/bootstrap reads the whole store)
 * or a client fetch that would flicker the one control the page exists for.
 * Kept dynamic deliberately; revisit if a `/api/bootstrap-lite` ever lands.
 */
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
