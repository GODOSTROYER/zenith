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

const BG = "#0b1020";
const INK = "#edf2ff";
const MUTE = "#adbad0";
const SIGNAL = "#55e6c1";

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
          <svg width="40" height="40" viewBox="0 0 24 24"><path d="M4 17a8 8 0 0 1 16 0M12 10v7" fill="none" stroke={SIGNAL} strokeWidth="1.5" strokeLinecap="round"/><circle cx="12" cy="4.5" r="2" fill={SIGNAL}/><circle cx="12" cy="19.5" r="1.3" fill={SIGNAL}/></svg>
          <div style={{ color: INK, fontSize: 30, fontWeight: 600, marginLeft: 16 }}>Zenith.ai</div>
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
            Your stack,
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
            clearly in view.
          </div>
          <div style={{ color: MUTE, fontSize: 30, lineHeight: 1.45, marginTop: 28, maxWidth: 880 }}>
            Map your system. Review each change. Keep the next step in view.
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
