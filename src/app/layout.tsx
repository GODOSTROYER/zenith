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
        <link rel="preload" href="/fonts/36966cca54120369-s.p.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/bb3ef058b751a6ad-s.p.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/*
          Apply the saved theme before paint. Dark is the default; "system"
          resolves against prefers-color-scheme here so there is no flash
          before ThemeToggle mounts.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("orrery-theme");if(t==="light"||(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches))document.documentElement.setAttribute("data-theme","light");}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
