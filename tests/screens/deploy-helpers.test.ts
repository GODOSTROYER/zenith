/**
 * The pure logic behind three honesty rules on the deploy surfaces:
 * what Copy/Open may claim about an output, what "total elapsed" means when a
 * deployment is still moving, and which revision a third comparison tick
 * pushed out of the pair.
 */
import { describe, expect, it } from "vitest";
import {
  absoluteHref,
  copyTarget,
  isSimulated,
  openLabel,
} from "@/components/deploy/output-link";
import { totalMs } from "@/components/ui/phase-timeline";
import { pickPair } from "@/app/(product)/p/[slug]/revisions/pick-pair";
import type { DeploymentStep, Output } from "@/lib/domain/types";

const ORIGIN = "https://zenith.test";

const url = (over: Partial<Output> = {}): Output => ({
  key: "url:svc",
  label: "web — https://web--staging.atlas.zenith.app",
  value: "/preview/dep_1/svc_1",
  kind: "url",
  ...over,
});

const connection = (): Output => ({
  key: "conn:db",
  label: "db — postgres.staging.atlas.zenith.app:5432",
  value: "postgres.staging.atlas.zenith.app:5432",
  kind: "connection",
});

describe("isSimulated", () => {
  it("prefers the output's own flag over the environment's provider", () => {
    expect(isSimulated({ simulated: true }, false)).toBe(true);
    expect(isSimulated({ simulated: false }, true)).toBe(false);
  });

  it("falls back to the environment when the provider did not say", () => {
    expect(isSimulated({}, true)).toBe(true);
    expect(isSimulated({}, false)).toBe(false);
  });

  it("stays unknown while the workspace payload is still loading", () => {
    expect(isSimulated({}, undefined)).toBeUndefined();
  });
});

describe("openLabel", () => {
  it("only says a bare Open when the address is known to be real", () => {
    expect(openLabel(false)).toBe("Open");
    expect(openLabel(true)).toBe("Open preview");
    // the bug this exists for: unknown must not render as real
    expect(openLabel(undefined)).toBe("Open preview");
  });
});

describe("absoluteHref", () => {
  it("makes a local preview path pasteable", () => {
    expect(absoluteHref("/preview/dep_1/svc_1", ORIGIN)).toBe(
      "https://zenith.test/preview/dep_1/svc_1"
    );
  });

  it("leaves an already absolute url alone", () => {
    expect(absoluteHref("https://app.example.com/x", ORIGIN)).toBe("https://app.example.com/x");
  });

  it("returns the value unchanged when there is no origin to resolve against", () => {
    expect(absoluteHref("/preview/x")).toBe("/preview/x");
    expect(absoluteHref("not a url", "also not a url")).toBe("not a url");
  });
});

describe("copyTarget", () => {
  it("copies the working preview link for a simulated url, never the fake host", () => {
    const t = copyTarget(url(), true, ORIGIN);
    expect(t.value).toBe("https://zenith.test/preview/dep_1/svc_1");
    expect(t.what).toMatch(/preview link/);
  });

  it("copies the real address for a real url", () => {
    expect(copyTarget(url(), false, ORIGIN).value).toBe("https://web--staging.atlas.zenith.app");
  });

  it("copies the connection string itself, which is never a link", () => {
    const t = copyTarget(connection(), true, ORIGIN);
    expect(t.value).toBe("postgres.staging.atlas.zenith.app:5432");
    expect(t.what).toBe("the connection value");
  });
});

/* ------------------------------ total elapsed ------------------------------ */

const step = (over: Partial<DeploymentStep> = {}): DeploymentStep => ({
  id: "s1",
  seq: 1,
  phase: "prepare",
  title: "step",
  targetId: "",
  status: "done",
  ...over,
});

describe("totalMs", () => {
  it("spans the first start to the last end, not the sum of the steps", () => {
    expect(
      totalMs([
        step({ id: "a", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" }),
        // one second of nothing happening in between — it still counts
        step({ id: "b", startedAt: "2026-01-01T00:00:03Z", endedAt: "2026-01-01T00:00:05Z" }),
      ])
    ).toBe(5000);
  });

  it("says nothing while a step is still pending or running", () => {
    const done = step({ startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" });
    expect(totalMs([done, step({ id: "b", status: "running" })])).toBeUndefined();
    expect(totalMs([done, step({ id: "b", status: "pending" })])).toBeUndefined();
  });

  it("counts a failed deployment, skipped steps and all", () => {
    expect(
      totalMs([
        step({ id: "a", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z" }),
        step({
          id: "b",
          status: "failed",
          startedAt: "2026-01-01T00:00:01Z",
          endedAt: "2026-01-01T00:00:04Z",
        }),
        step({ id: "c", status: "skipped" }),
      ])
    ).toBe(4000);
  });

  it("says nothing when no step ever carried a timestamp", () => {
    expect(totalMs([step({ startedAt: undefined, endedAt: undefined })])).toBeUndefined();
    expect(totalMs([])).toBeUndefined();
  });
});

/* -------------------------------- pickPair -------------------------------- */

describe("pickPair", () => {
  it("adds up to two", () => {
    expect(pickPair([], "a")).toEqual({ ids: ["a"], released: undefined });
    expect(pickPair(["a"], "b")).toEqual({ ids: ["a", "b"], released: undefined });
  });

  it("names the revision the third tick pushed out", () => {
    expect(pickPair(["a", "b"], "c")).toEqual({ ids: ["b", "c"], released: "a" });
  });

  it("unticks without claiming anything was released", () => {
    expect(pickPair(["a", "b"], "a")).toEqual({ ids: ["b"] });
  });
});
