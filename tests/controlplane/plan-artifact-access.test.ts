/** Canonical custody contract only; native cleanup suites separately prove dispatch. */
import { describe, expect, it } from "vitest";
import { captureArtifactAccess, type ArtifactAccess } from "@/lib/controlplane/db/repos/plan-artifacts";
import { digest } from "@/lib/controlplane/digest";

const input = (): ArtifactAccess => ({
  custody: { workspaceId: "workspace", projectId: "project", environmentId: "environment", operationId: "operation",
    proposalDigest: "proposal", inputDigest: "input", expiresAt: "2026-10-06T00:00:00.000Z", sourceDigest: "source", graphDigest: "graph" },
  planDigest: "plan", lease: { scope: "env:environment", holder: "worker:operation", fenceToken: 7 },
});

describe("canonical immutable plan artifact access", () => {
  it("accepts actual repository lease metadata without changing any authenticated authority", () => {
    const bare = input();
    const full = { ...bare, lease: { ...bare.lease, acquiredAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:05:00.000Z" } };
    const captured = captureArtifactAccess(full);
    expect(digest(captured)).toBe(digest(captureArtifactAccess(bare)));
    full.custody.workspaceId = "foreign";
    full.lease.holder = "foreign";
    expect(captured.custody.workspaceId).toBe("workspace");
    expect(captured.lease.holder).toBe("worker:operation");
    expect(() => { captured.lease.fenceToken = 8; }).toThrow();
    expect(() => { captured.custody.graphDigest = "changed"; }).toThrow();
  });

  it("retains every approval and dispatch relevant field in the canonical digest", () => {
    const original = input();
    const expected = digest(captureArtifactAccess(original));
    for (const key of Object.keys(original.custody) as (keyof ArtifactAccess["custody"])[]) {
      const changed = input();
      changed.custody[key] += "-changed";
      expect(digest(captureArtifactAccess(changed)), key).not.toBe(expected);
    }
    for (const key of ["scope", "holder"] as const) {
      const changed = input(); changed.lease[key] += "-changed";
      expect(digest(captureArtifactAccess(changed)), key).not.toBe(expected);
    }
    const fence = input(); fence.lease.fenceToken++;
    expect(digest(captureArtifactAccess(fence))).not.toBe(expected);
    const plan = input(); plan.planDigest += "-changed";
    expect(digest(captureArtifactAccess(plan))).not.toBe(expected);
  });
});
