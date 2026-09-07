/**
 * Real health probes and real log lines (G28).
 *
 * Every assertion here is about something that was actually read: a row, a
 * pragma, an artifact's bytes re-hashed from disk, a counter. The one thing
 * this file guards more than any other is that `simulated` is never true — the
 * infrastructure product has a labelled simulated health surface, and a hosted
 * app's health must never be confused with it.
 *
 * Workstream W8 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-health-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { appHealth, appLogs } = await import("@/lib/hosted/health");
const { admitRequest } = await import("@/lib/hosted/quota");
const { recordEvent } = await import("@/lib/hosted/events");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { OWNER, seedActiveRelease, seedApp, seedArtifact, seedGrant, seedRecord } = await import(
  "../backup/_ops-fixtures"
);

const a = openAuthority();
const artifactRoot = path.join(dataDir, "artifacts");
const app = seedApp(a, { slug: "health-app", workspaceId: "ws-health" });
seedGrant(a, app.id, OWNER, "owner");

const { digest } = await seedArtifact(a, artifactRoot, { marker: "health" });
const release = seedActiveRelease(a, app.id, digest);
for (let n = 0; n < 3; n++) await seedRecord(app.id, { title: `Health record ${n}` });

afterAll(() => {
  closeAllAppData();
  closeAuthority();
  removeDir(dataDir);
});

const artifactFile = path.join(artifactRoot, "sha256", digest, "files", "index.html");

describe("appHealth", () => {
  it("runs every probe for real and never reports a simulated result", async () => {
    admitRequest(app.id, { limit: 100 });
    admitRequest(app.id, { limit: 1 });
    admitRequest(app.id, { limit: 1 });
    recordEvent({ event: "record.created", workspaceId: "ws-health", appId: app.id, subject: OWNER.subject, releaseId: release.id });
    recordEvent({ event: "record.conflict", workspaceId: "ws-health", appId: app.id, subject: OWNER.subject, releaseId: release.id, outcome: "error" });
    recordEvent({ event: "access.denied", workspaceId: "ws-health", appId: app.id, outcome: "denied" });

    const health = await appHealth(app.id);

    expect(health.simulated).toBe(false);
    expect(health.ok).toBe(true);
    expect(health.slug).toBe("health-app");
    expect(health.release).toEqual({ id: release.id, number: release.number, digest });
    expect(health.runtime).toMatchObject({ id: "local" });
    expect(health.runtime.enforcement.requestCpuMs).toBe("not_enforced");

    const byId = Object.fromEntries(health.checks.map((check) => [check.id, check]));
    expect(Object.keys(byId).sort()).toEqual([
      "active_release",
      "artifact_verified",
      "authority_row",
      "data_quick_check",
      "records",
      "schema_version",
    ]);
    expect(byId.artifact_verified.detail).toMatch(/re-hashed from its stored bytes/);
    expect(byId.data_quick_check.detail).toMatch(/reported ok/);
    expect(byId.schema_version.detail).toMatch(/version 1/);
    expect(byId.records.detail).toMatch(/^3 equipment request\(s\)/);

    // Counted from the same event rows the owner can read.
    expect(health.lastEvents).toMatchObject({ total: 3, writes: 1, conflicts: 1, denials: 1, errors: 1 });
    expect(health.lastEvents.byEvent["record.created"]).toBe(1);
    // And today's quota counter is the real one.
    expect(health.quota).toMatchObject({ requests: 3, denied: 2 });
  });

  it("fails the artifact check when a byte of the release changes, and stays honest about the rest", async () => {
    const original = fs.readFileSync(artifactFile);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x3e ? 0x3d : 0x3e;
    fs.writeFileSync(artifactFile, tampered);
    try {
      const health = await appHealth(app.id);
      expect(health.simulated).toBe(false);
      expect(health.ok).toBe(false);
      const artifact = health.checks.find((check) => check.id === "artifact_verified");
      expect(artifact?.ok).toBe(false);
      expect(artifact?.detail).toMatch(/does not match its own manifest/);
      // Only that one probe failed: a health report names the fault it found.
      expect(health.checks.filter((check) => !check.ok)).toHaveLength(1);
    } finally {
      fs.writeFileSync(artifactFile, original);
    }
  });

  it("reports an app with no active release as not ok, rather than as healthy-with-nothing", async () => {
    const bare = seedApp(a, { slug: "health-bare", workspaceId: "ws-health" });
    const health = await appHealth(bare.id);
    expect(health.simulated).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.release).toBeNull();
    expect(health.checks.find((check) => check.id === "active_release")?.detail).toMatch(
      /nothing for it to serve/
    );
    // The app's own database still answers, so those probes still pass.
    expect(health.checks.find((check) => check.id === "data_quick_check")?.ok).toBe(true);
  });

  it("reports a suspended app's state rather than hiding it behind an ok", async () => {
    a.tx(() => a.repos.apps.update(app.id, { state: "suspended", stateReason: "operator paused it" }));
    try {
      const health = await appHealth(app.id);
      expect(health.state).toBe("suspended");
      expect(health.stateReason).toBe("operator paused it");
      expect(health.checks.find((check) => check.id === "authority_row")?.ok).toBe(false);
      expect(health.ok).toBe(false);
    } finally {
      a.tx(() => a.repos.apps.update(app.id, { state: "active", stateReason: null }));
    }
  });

  it("answers for an app that does not exist without inventing anything", async () => {
    const health = await appHealth("00000000-0000-4000-8000-000000000000");
    expect(health.simulated).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.checks).toEqual([
      { id: "authority_row", ok: false, detail: expect.stringContaining("holds no app with the id") },
    ]);
  });
});

describe("appLogs", () => {
  it("renders each line with the release that served it, and no content", () => {
    const logs = appLogs(app.id, { limit: 50 });
    expect(logs.lines.length).toBeGreaterThan(0);

    const withRelease = logs.lines.filter((line) => line.releaseId === release.id);
    expect(withRelease.length).toBeGreaterThan(0);
    for (const line of withRelease) expect(line.line).toContain(`[${release.id}]`);

    const created = logs.lines.find((line) => line.event === "record.created");
    expect(created?.line).toMatch(new RegExp(`^\\S+ \\[${release.id}\\] record\\.created ok$`));

    // An event recorded outside a release says so rather than pretending.
    const denied = logs.lines.find((line) => line.event === "access.denied");
    expect(denied?.releaseId).toBeNull();
    expect(denied?.line).toContain("[no-release]");

    // Nothing a record contains reaches a log line.
    const rendered = logs.lines.map((line) => line.line).join("\n");
    expect(rendered).not.toContain("Health record");
    expect(rendered).not.toContain(OWNER.email);
    expect(rendered).not.toContain(OWNER.subject);
    expect(logs.disclosure).toMatch(/never a record's contents/);
  });

  it("is bounded", () => {
    expect(appLogs(app.id, { limit: 2 }).lines).toHaveLength(2);
    expect(appLogs(app.id, { limit: 100_000 }).lines.length).toBeLessThanOrEqual(1000);
  });
});
