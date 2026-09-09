/**
 * The Zenith landing page — the front door.
 * Direction: "The Revision Object" — see docs/zenith-reimagined-direction.md.
 * Product users pass straight through via the Open Zenith CTA; the page
 * pulls its provider table live from the registry so it can never overclaim.
 */
import type { Metadata } from "next";
import { ensureEngine } from "@/lib/engine/engine";
import { providerRegistry } from "@/lib/providers/types";
import { Landing, type ProviderRow } from "@/components/landing/landing";

const TITLE = "Zenith — see the change before you ship";
const DESCRIPTION =
  "Your next infrastructure change, made tangible. Inspect the system, review estimated cost and risk, and approve supported execution. Local-first, bring your own cloud.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Absolute-URL base for the generated social card (see opengraph-image.tsx).
  // Docker's optional build argument is an empty string when not supplied.
  // Treat blank and unset alike; an invalid nonblank URL still fails visibly.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3400"),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Zenith",
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
 * Static. The front door is the same page for everyone, so it is built once.
 *
 * What used to make it dynamic was the CTA: it needed the session
 * (`getSessionUser`, which reads cookies) and the workspace count (`db()`).
 * Both moved to `GET /api/me`, which the CTA fetches for itself — see
 * components/landing/cta.tsx. Nothing left in this file reads a request.
 *
 * The provider honesty table still comes from the registry, now read at build
 * time, which is the honest source either way: the registry is populated by
 * `ensureEngine()` from a literal list of adapters, so it is a constant of the
 * build, not of the request. `ensureEngine()` and not `ensureBoot()` on
 * purpose — boot also claims the data directory with a pid lock and resumes
 * in-flight deployments, neither of which belongs in a build, and the lock
 * would fail the build outright whenever a dev server held it.
 *
 * `force-static` rather than relying on the default `"auto"`: the default
 * would still prerender this page, but silently stops doing so the day someone
 * adds a `cookies()` call, and nothing in the build output would say the front
 * door had become per-request. Declared, it stays static — under `force-static`
 * the dynamic APIs return empty values rather than opting the route out.
 *
 * That is the trade: `"error"` would refuse the build instead of handing back
 * an empty cookie jar. Worth switching to if this page ever grows a reason to
 * read a request at all.
 */
export const dynamic = "force-static";

export default async function LandingPage() {
  // registers the provider adapters the honesty table reads below
  ensureEngine();
  const providers: ProviderRow[] = [...providerRegistry().values()].map((p) => ({
    id: p.id,
    displayName: p.displayName,
    availability: p.availability,
    tagline: p.tagline,
  }));
  // Roadmap presentation only: this is not a registered connection/provider.
  providers.push({ id: "oracle-coming-later", displayName: "Oracle Cloud", availability: "planned", tagline: "Coming later. Oracle connections and operations are not available yet." });

  return <>
    <link rel="preload" href="/fonts/instrument-serif-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
    <link rel="preload" href="/fonts/instrument-serif-italic-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
    <link rel="preload" href="/fonts/manrope-latin-variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
    <Landing providers={providers} />
  </>;
}
