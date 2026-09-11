import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Manifest, Revision } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-manifests-");
const { db, flush, onChange, q, resetDb, save } = await import("@/lib/db/store");

const STATE = path.join(DATA, "state.json");
const MANIFESTS = path.join(DATA, "revisions");

const manifest = (serviceName: string): Manifest =>
  ({
    version: 1,
    name: "demo",
    services: [{ id: "svc", name: serviceName, kind: "web" }],
    resources: [],
    routes: [],
    bindings: [],
  }) as unknown as Manifest;

const revision = (id: string, projectId: string, m: Manifest): Revision => ({
  id,
  projectId,
  number: 1,
  manifest: m,
  message: "first",
  author: { type: "user", id: "u", name: "You" },
  createdAt: new Date().toISOString(),
});

/** Simulate a cold process against the same directory. */
function coldBoot(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.__zenithDb;
  delete g.__zenithManifests;
}

const stateText = () => fs.readFileSync(STATE, "utf8");

beforeEach(() => {
  resetDb();
});

describe("revision manifests in the side store", () => {
  it("moves an inline manifest out of state.json and reads it back", () => {
    db().revisions.push(revision("r1", "p1", manifest("api")));
    flush();

    // state.json holds the metadata and not one byte of the manifest.
    const text = stateText();
    expect(text).toContain('"r1"');
    expect(text).not.toContain("api");
    expect(fs.existsSync(path.join(MANIFESTS, "r1.json"))).toBe(true);

    // Both the accessor and the plain property still answer.
    expect(q.revisionManifest("r1")?.services[0].name).toBe("api");
    expect(q.revision("r1")!.manifest.services[0].name).toBe("api");
  });

  it("survives a restart: the manifest comes back from disk, not memory", () => {
    db().revisions.push(revision("r2", "p1", manifest("worker")));
    flush();
    coldBoot();

    expect(q.revision("r2")!.manifest.services[0].name).toBe("worker");
  });

  it("migrates a pre-split snapshot on first load", () => {
    // A state.json written by the old store: manifests inline.
    const legacy = {
      ...db(),
      revisions: [revision("r3", "p1", manifest("legacy-svc"))],
    };
    fs.writeFileSync(STATE, JSON.stringify(legacy), "utf8");
    fs.rmSync(MANIFESTS, { recursive: true, force: true });
    coldBoot();

    // Loading is enough — the migration writes the side files and rewrites
    // state.json before anyone can read a revision.
    expect(db().revisions).toHaveLength(1);
    expect(fs.existsSync(path.join(MANIFESTS, "r3.json"))).toBe(true);
    expect(stateText()).not.toContain("legacy-svc");
    expect(q.revisionManifest("r3")?.services[0].name).toBe("legacy-svc");
  });

  it("refuses to invent an empty manifest when the file is missing", () => {
    db().revisions.push(revision("r4", "p1", manifest("gone")));
    flush();
    fs.rmSync(path.join(MANIFESTS, "r4.json"));
    coldBoot();

    // An empty manifest here would read as "delete every service" in a diff —
    // which is the plan a rollback would then apply.
    expect(() => q.revision("r4")!.manifest).toThrow(/no stored manifest/);
  });

  it("drops side files whose revision is gone", () => {
    db().revisions.push(revision("r5", "p1", manifest("doomed")));
    flush();
    expect(fs.existsSync(path.join(MANIFESTS, "r5.json"))).toBe(true);

    db().revisions = db().revisions.filter((r) => r.id !== "r5");
    flush();
    expect(fs.existsSync(path.join(MANIFESTS, "r5.json"))).toBe(false);
  });

  it("writes an assigned manifest through to the side store", () => {
    db().revisions.push(revision("r6", "p1", manifest("before")));
    flush();
    q.revision("r6")!.manifest = manifest("after");
    coldBoot();

    expect(q.revisionManifest("r6")?.services[0].name).toBe("after");
  });
});

describe("change events", () => {
  const collect = (): { seen: { projectIds: string[] }[]; stop: () => void } => {
    const seen: { projectIds: string[] }[] = [];
    const stop = onChange((c) => seen.push({ projectIds: [...c.projectIds] }));
    return { seen, stop };
  };

  it("fires once per write, naming the project the caller touched", () => {
    const { seen, stop } = collect();
    save("p-alpha");
    save("p-alpha"); // coalesced into the same window
    flush();
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].projectIds).toEqual(["p-alpha"]);
  });

  it("names every project a coalesced window touched", () => {
    const { seen, stop } = collect();
    save("p-alpha");
    save("p-beta");
    flush();
    stop();

    expect(seen[0].projectIds.sort()).toEqual(["p-alpha", "p-beta"]);
  });

  it("broadcasts when any save in the window did not name a project", () => {
    const { seen, stop } = collect();
    save("p-alpha");
    save(); // a caller that does not know: the whole window is now unknown
    flush();
    stop();

    // Empty means "assume any project", never "nothing changed".
    expect(seen[0].projectIds).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const { seen, stop } = collect();
    stop();
    save("p-alpha");
    flush();

    expect(seen).toHaveLength(0);
  });
});
