import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

const jbmono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Orrery", template: "%s · Orrery" },
  description:
    "Orrery — a bring-your-own-cloud deployment and operations platform. Your infrastructure, in motion.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
      <body className={`${grotesk.variable} ${jbmono.variable}`}>{children}</body>
    </html>
  );
}
