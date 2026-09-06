import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Zenith.ai", template: "%s · Zenith.ai" },
  description:
    "Your stack, clearly in view. Map your application and review each change with Zenith.ai. LocalStack execution and AWS Terraform export are supported.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preload" href="/fonts/manrope-latin-variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/bb3ef058b751a6ad-s.p.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/*
          Apply the saved theme before paint. The landing defaults to porcelain;
          product routes retain their dark default. "system" follows the device.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("orrery-theme");if(t==="light"||(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches)||(!t&&location.pathname==="/"))document.documentElement.setAttribute("data-theme","light");}catch(e){if(location.pathname==="/")document.documentElement.setAttribute("data-theme","light");}`,
          }}
        />
      </head>
      <body>
        <template dangerouslySetInnerHTML={{ __html: `<!--
Landing direction contract / test/zenith-reimagined
THESIS: The next infrastructure change becomes a physical revision object.
OWN-WORLD: Porcelain, ink and vermilion; cut-register vector identity, Instrument Serif, Manrope and precise monospaced evidence.
STORY: Inspect Atlas, review its queue and bindings, approve a simulation, inspect the audit, restore configuration and choose a supported starting point.
FIRST VIEWPORT: Monumental editorial headline and real CTA on the left; immediately visible dimensional infrastructure on the right. Mobile stacks both.
FORM: Revision Object, first of three internally challenged directions; user-selected territory, seed 5d9df14d advisory only.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->` }} />
        {children}
      </body>
    </html>
  );
}
