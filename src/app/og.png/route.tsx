/** Static social card; the .png route retains the public middleware exception. */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ZENITH_SYMBOL_PATHS, ZENITH_LETTER_PATHS } from "@/components/shell/brand-geometry";

export const dynamic = "force-static";

export async function GET() {
  const display = await readFile(path.join(process.cwd(), "public/fonts/instrument-serif-og.ttf"));
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", background: "#f4f3ee", color: "#20211f", display: "flex", flexDirection: "column", padding: "54px 64px", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
        <svg width="42" height="42" viewBox="0 0 32 32" fill="#20211f">{ZENITH_SYMBOL_PATHS.map((d) => <path key={d} d={d} />)}</svg>
        <svg width="157" height="42" viewBox="0 0 256 66" fill="#20211f">{ZENITH_LETTER_PATHS.map((d) => <path key={d} d={d} fillRule="evenodd" />)}</svg>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", fontFamily: "Instrument Serif", fontSize: 100, lineHeight: 1, letterSpacing: "-.025em" }}><span>See the change.</span><span>Before you ship.</span></div>
        <svg width="240" height="240" viewBox="0 0 32 32" fill="#cc3d25">{ZENITH_SYMBOL_PATHS.map((d) => <path key={d} d={d} />)}</svg>
      </div>
      <div style={{ display: "flex", borderTop: "1px solid #cccec4", paddingTop: 24, fontSize: 21, color: "#606259" }}>Local-first deployment & operations. The next change, made tangible.</div>
    </div>,
    { width: 1200, height: 630, fonts: [{ name: "Instrument Serif", data: display, weight: 400, style: "normal" }] },
  );
}
