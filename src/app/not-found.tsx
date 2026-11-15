import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
};

/** Keep missing routes on the shared theme instead of Next's OS-only palette. */
export default function NotFound() {
  return (
    <main
      aria-labelledby="not-found-title"
      aria-describedby="not-found-description"
      className="flex min-h-dvh flex-col items-center justify-center bg-bg0 px-6 py-10 text-ink"
    >
      <div className="flex max-w-full flex-col items-center gap-4 sm:flex-row sm:gap-5">
        <h1
          id="not-found-title"
          className="font-mono text-2xl font-medium leading-none sm:border-r sm:border-line-strong sm:py-3 sm:pr-5"
        >
          404
        </h1>
        <p id="not-found-description" className="text-center text-sm leading-7">
          This page could not be found.
        </p>
      </div>
      <Link
        href="/"
        className="mt-5 inline-flex min-h-11 items-center rounded-ctl px-2 text-[13px] text-ink-mute underline decoration-line-strong underline-offset-4 hover:text-ink"
      >
        Return to Zenith
      </Link>
    </main>
  );
}
