import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Zenith", template: "%s · Zenith" },
  description:
    "Your stack, clearly in view. Map your application and review each change with Zenith. LocalStack execution and AWS Terraform export are supported.",
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
            __html: `try{var t=localStorage.getItem("zenith-theme");if(t==="light"||(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches)||(!t&&location.pathname==="/"))document.documentElement.setAttribute("data-theme","light");}catch(e){if(location.pathname==="/")document.documentElement.setAttribute("data-theme","light");}`,
          }}
        />
      </head>
      <body>
        <template dangerouslySetInnerHTML={{ __html: `<!--
Landing direction contract / your cloud, in full view
THESIS: One system, seen before, during and after the change, with Gimbal as the guide who lives in the corner.
OWN-WORLD: Porcelain, ink and vermilion; cut-register vector identity, Instrument Serif, Manrope and precise monospaced evidence.
STORY: Build with the agents you already use, understand the system and the plan, explore growth, choose your path, observe after deployment, decide how much to delegate, keep what is yours.
FIRST VIEWPORT: Monumental editorial headline and real CTA on the left; the application assembling into a readable system on the right; the two paths and their availability stated. Mobile stacks both.
FORM: Eight chapters over one shared presentation state; no demonstration may contradict another.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, DESIGN.md, docs/zenith-landing-direction.md and the verification notes
-->` }} />
        {children}
      </body>
    </html>
  );
}
