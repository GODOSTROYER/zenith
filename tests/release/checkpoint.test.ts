/** PROD-REL-04: resumable checkpoints. Contract level plus a real temporary file; no cloud. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointError, RunCheckpoint, assertSafeCommand, fileStore, memoryStore, type CheckpointStore } from "../../scripts/release/checkpoint";
import { digest } from "@/lib/controlplane/digest";

const SCOPE = digest("scope-a");
const open = (store: CheckpointStore = memoryStore(), over: Partial<Parameters<typeof RunCheckpoint.open>[0]> = {}) =>
  RunCheckpoint.open({ store, runId: "zlive-202610071200-abcd", harness: "mixed-traffic-live", scopeDigest: SCOPE, steps: ["one", "two", "three"], now: () => new Date("2026-10-08T00:00:00Z"), ...over });
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return e instanceof CheckpointError ? e.code : "other"; } return undefined; };

describe("run checkpoint", () => {
  it("starts with every step pending and never claims unattended work", () => {
    const store = memoryStore();
    const { checkpoint, resumed } = open(store);
    expect(resumed).toBe(false);
    expect(checkpoint.state.steps.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    expect(store.snapshot()!.unattendedClaims).toBe(false);
    expect(checkpoint.summary().complete).toBe(false);
  });

  it("records progress after every step and lists what remains", () => {
    const store = memoryStore();
    const { checkpoint } = open(store);
    checkpoint.begin("one");
    expect(store.snapshot()!.steps[0]).toMatchObject({ status: "in_progress", attempts: 1 });
    checkpoint.complete("one", "ok", digest("evidence"));
    checkpoint.begin("two");
    checkpoint.fail("two", "boom");
    expect(checkpoint.remaining()).toEqual(["two", "three"]);
    expect(store.snapshot()!.steps[0]).toMatchObject({ status: "done", evidenceDigest: digest("evidence") });
  });

  it("resumes without repeating done steps, and marks a step that was running as interrupted, never done", () => {
    const store = memoryStore();
    const first = open(store).checkpoint;
    first.begin("one"); first.complete("one");
    first.begin("two"); // the process dies here
    const again = open(store);
    expect(again.resumed).toBe(true);
    expect(again.interrupted).toEqual(["two"]);
    expect(again.checkpoint.state.steps.map((s) => s.status)).toEqual(["done", "interrupted", "pending"]);
    expect(again.checkpoint.remaining()).toEqual(["two", "three"]);
    again.checkpoint.begin("two");
    expect(again.checkpoint.state.steps[1]!.attempts).toBe(2);
  });

  it("refuses to resume under a different scope, run or harness", () => {
    const store = memoryStore();
    open(store);
    expect(code(() => open(store, { scopeDigest: digest("scope-b") }))).toBe("scope_changed");
    expect(code(() => open(store, { runId: "zlive-202610071200-zzzz" }))).toBe("run_mismatch");
    expect(code(() => open(store, { harness: "other" }))).toBe("run_mismatch");
  });

  it("only allows legal transitions on known steps", () => {
    const { checkpoint } = open();
    expect(code(() => checkpoint.complete("one"))).toBe("illegal_transition");
    expect(code(() => checkpoint.begin("nope"))).toBe("unknown_step");
    checkpoint.begin("one"); checkpoint.complete("one");
    expect(code(() => checkpoint.begin("one"))).toBe("illegal_transition");
    expect(code(() => checkpoint.skip("one", "later"))).toBe("illegal_transition");
  });

  it("adds new steps on resume and keeps decisions", () => {
    const store = memoryStore();
    const a = open(store).checkpoint;
    a.decide("A Person", "approved the budget");
    const b = open(store, { steps: ["one", "two", "three", "four"] }).checkpoint;
    expect(b.state.steps.map((s) => s.id)).toEqual(["one", "two", "three", "four"]);
    expect(b.state.decisions).toHaveLength(1);
  });

  it("stores exact next commands and refuses any that carry a secret value", () => {
    const { checkpoint } = open();
    checkpoint.setNextCommands(["ZENITH_LIVE_MIXED_TOKEN_FILE=/secure/token.txt npx tsx scripts/acceptance/mixed/live-run.ts"]);
    expect(checkpoint.state.nextCommands).toHaveLength(1);
    expect(code(() => checkpoint.setNextCommands(["ZENITH_LIVE_API_TOKEN=abcdefghijklmnop123456 npx tsx x.ts"]))).toBe("unsafe_command");
    expect(code(() => assertSafeCommand("curl --token abcdefghijk123 https://x"))).toBe("unsafe_command");
    expect(code(() => assertSafeCommand("echo -----BEGIN RSA PRIVATE KEY-----"))).toBe("unsafe_command");
    expect(() => assertSafeCommand("npx tsx scripts/release/permissions-cli.ts approve --by <name>")).not.toThrow();
    expect(() => assertSafeCommand("ZENITH_LIVE_API_TOKEN_FILE=$HOME/token npx tsx x.ts")).not.toThrow();
  });

  it("is complete only when every step is done or skipped", () => {
    const { checkpoint } = open();
    for (const id of ["one", "two"]) { checkpoint.begin(id); checkpoint.complete(id); }
    checkpoint.skip("three", "not applicable");
    expect(checkpoint.summary()).toMatchObject({ complete: true, done: ["one", "two"], skipped: ["three"] });
  });
});

describe("file store", () => {
  it("writes atomically, round-trips, and refuses a tampered or malformed file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zckpt-"));
    const file = path.join(dir, "nested", "checkpoint.json");
    const store = fileStore(file);
    const { checkpoint } = open(store);
    checkpoint.begin("one");
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(open(fileStore(file)).resumed).toBe(true);
    const tampered = JSON.parse(readFileSync(file, "utf8")) as { unattendedClaims: boolean };
    tampered.unattendedClaims = true;
    writeFileSync(file, JSON.stringify(tampered));
    expect(code(() => fileStore(file).read())).toBe("invalid");
    writeFileSync(file, "{broken");
    expect(code(() => open(fileStore(file)))).toBe("invalid");
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  it("returns undefined for a missing file", () => {
    expect(fileStore(path.join(os.tmpdir(), `zckpt-missing-${process.pid}.json`)).read()).toBeUndefined();
  });
});
