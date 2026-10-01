import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceRecorder } from "../../scripts/acceptance/evidence";
import { context, RUN, temp } from "./_helpers";

describe("honest, redacted evidence", () => {
  it("reports durable event write failures instead of silently passing", async () => {
    const e = new EvidenceRecorder({ runId: RUN, scenarios: ["J"], provenance: "local", outDir: await temp() });
    await mkdir(path.join(e.dir, "events.jsonl"), { recursive: true });
    await e.init(); e.pass("J", "a", "checked"); await expect(e.finalize()).rejects.toThrow("Evidence event writes failed");
  });
  it("removes exact opaque tokens before truncation and retains events recorded before init", async () => {
    const e = new EvidenceRecorder({ runId: RUN, scenarios: ["J"], provenance: "local", outDir: await temp(), secrets: ['opaque-token-with-"quote'] });
    e.note('early opaque-token-with-"quote'); e.pass("J", "opaque", "safe", 'x'.repeat(1990) + 'opaque-token-with-"quote');
    await e.finalize(); const events = await readFile(path.join(e.dir, "events.jsonl"), "utf8"); expect(events).toContain("early [REDACTED TOKEN]");
    for (const name of await readdir(e.dir)) { const text = await readFile(path.join(e.dir, name), "utf8"); expect(text).not.toContain("opaque-token-with"); }
  });
  it("never counts a skip as passed", async () => { const c = await context(); c.evidence.pass("J", "a", "ran"); c.evidence.skip("J", "b", "not run", "blocked"); const s = await c.evidence.finalize(); expect(s.verdict).toBe("incomplete"); expect(s.counts).toEqual({ passedLive: 0, passedLocal: 1, passedSimulated: 0, failed: 0, skipped: 1 }); });
  it("refuses fabricated live results and overwrite of failure", async () => { const c = await context("simulated"); expect(() => c.evidence.pass("A", "a", "fake", "", "live")).toThrow(); c.evidence.fail("A", "a", "failed"); expect(() => c.evidence.pass("A", "a", "replace")).toThrow(); expect(() => c.evidence.skip("A", "b", "skipped", "")).toThrow(); });
  it("a dry run can only record skips", async () => { const c = await context("dry_run"); expect(() => c.evidence.pass("A", "a", "run")).toThrow(); c.evidence.skip("A", "a", "planned", "dry run"); const s = await c.evidence.finalize(); expect(s.verdict).toBe("dry_run"); expect(s.counts.passedLive + s.counts.passedLocal).toBe(0); });
  it("redacts canaries from every artifact before truncating", async () => {
    const c = await context();
    const canaries = ["AKIAABCDEFGHIJKLMNOP", "Ab1/".repeat(10), "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature123", "IQoJ" + "aB1/".repeat(60), "-----BEGIN PRIVATE KEY-----\nCANARY_SECRET\n-----END PRIVATE KEY-----"];
    const text = canaries.join(" ");
    c.evidence.note(text); c.evidence.pass("J", "redact", text, text);
    c.evidence.logQuery("J", { source: text, query: text, lines: [text, "x".repeat(1_980) + " " + canaries[1]!] });
    c.evidence.httpProbe("J", { label: text, url: "http://localhost", ok: false, bodySnippet: "x".repeat(480) + " " + canaries[1]! });
    c.evidence.operation("J", { operationId: "op", detail: text });
    await c.evidence.finalize();
    for (const name of await readdir(c.evidence.dir)) { const file = await readFile(path.join(c.evidence.dir, name), "utf8"); for (const value of canaries) expect(file).not.toContain(value); expect(file).not.toContain(canaries[1]!.slice(0, 19)); expect(file).not.toContain("CANARY_SECRET"); }
  });
  it("places files under outDir/runId and bounds logs/probe bodies", async () => {
    const outDir = await temp(); const e = new EvidenceRecorder({ runId: RUN, scenarios: ["J"], provenance: "local", outDir }); await e.init();
    e.logQuery("J", { source: "test", query: "q", lines: Array(501).fill("x".repeat(3000)) as string[] }); e.httpProbe("J", { label: "p", url: "http://localhost", ok: true, bodySnippet: "x".repeat(3000) });
    await e.finalize(); expect(e.dir).toBe(path.join(outDir, RUN)); const raw = JSON.parse(await readFile(path.join(e.dir, "evidence.json"), "utf8")); expect(raw.logQueries[0].lines).toHaveLength(500); expect(raw.logQueries[0].lines[0].length).toBeLessThanOrEqual(2001); expect(raw.httpProbes[0].bodySnippet.length).toBeLessThanOrEqual(501);
  });
});
