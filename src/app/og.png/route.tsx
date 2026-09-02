/**
 * The social card. Generated with next/og (no asset pipeline, no binary in
 * the repo) so it stays in step with the wordmark and the dark palette.
 *
 * Why a route called og.png rather than the `opengraph-image` file
 * convention: the auth middleware's matcher skips paths ending in an image
 * extension, so this one reaches a crawler. `/opengraph-image` does not —
 * it redirects to /login unless it is added to PUBLIC_PATHS.
 *
 * Satori has no CSS variables, so the four tokens it needs are inlined —
 * they are the dark-theme values from globals.css.
 */
import { ImageResponse } from "next/og";

const size = { width: 1200, height: 630 };

const BG = "#0a0d13";
const INK = "#e9edf5";
const MUTE = "#9aa5bd";
const SIGNAL = "#53e0be";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BG,
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* the app's mark: a ring with one satellite at its top right */}
          <div style={{ display: "flex", position: "relative", width: 34, height: 34 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                border: `3px solid ${SIGNAL}`,
                display: "flex",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: -6,
                left: 17,
                width: 12,
                height: 12,
                borderRadius: 999,
                background: SIGNAL,
                display: "flex",
              }}
            />
          </div>
          <div style={{ color: INK, fontSize: 30, fontWeight: 600, marginLeft: 16 }}>Orrery</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              color: INK,
              fontSize: 82,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.03,
            }}
          >
            Your infrastructure,
          </div>
          <div
            style={{
              color: SIGNAL,
              fontSize: 82,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.03,
            }}
          >
            in motion.
          </div>
          <div style={{ color: MUTE, fontSize: 30, lineHeight: 1.45, marginTop: 28, maxWidth: 880 }}>
            Shows the whole system, prices every change before it applies, and ends every deploy
            with a URL you can open.
          </div>
        </div>

        <div style={{ display: "flex", color: MUTE, fontSize: 24 }}>
          Bring your own cloud · plan-first · no lock-in
        </div>
      </div>
    ),
    size
  );
}
