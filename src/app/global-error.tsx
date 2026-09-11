"use client";
/**
 * Last-resort boundary: this replaces the root layout, so the stylesheet, the
 * font variables and the UI kit are all gone by the time it renders. Styles are
 * inline and it imports nothing from the app — whatever broke, it cannot be
 * this file's dependency. Tokens are copied from globals.css (dark ground).
 */
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[zenith/ui] root error", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "32px",
          background: "#0a0d13",
          color: "#e9edf5",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <main
          style={{
            width: "100%",
            maxWidth: 560,
            background: "#141a26",
            border: "1px solid rgba(151,165,199,0.14)",
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Zenith could not start</h1>
          <p style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6, color: "#9aa5bd" }}>
            The application shell itself failed to render, so no screen can load. Nothing
            was changed by this: your system definition, revisions and deployment history
            are on the server, and any deployment that was running is still running.
          </p>
          <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: "#9aa5bd" }}>
            Reload first. If it fails again, the server is the place to look — check the
            terminal running <code style={{ fontFamily: "ui-monospace, monospace" }}>npm run dev</code>{" "}
            for the stack trace behind the reference below.
          </p>
          <pre
            style={{
              marginTop: 12,
              maxHeight: 160,
              overflow: "auto",
              background: "#0f131c",
              border: "1px solid rgba(151,165,199,0.14)",
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "#9aa5bd",
              whiteSpace: "pre-wrap",
            }}
          >
            {error.message || String(error)}
            {error.digest ? `\n\nServer reference: ${error.digest}` : ""}
          </pre>
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                cursor: "pointer",
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 600,
                background: "#53e0be",
                color: "#04241c",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                cursor: "pointer",
                borderRadius: 8,
                padding: "8px 14px",
                fontSize: 13,
                background: "transparent",
                border: "1px solid rgba(151,165,199,0.26)",
                color: "#e9edf5",
              }}
            >
              Reload the page
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
