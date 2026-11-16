import { describe, expect, it } from "vitest";
import { describeEvent, groupByCorrelation, safeDataEntries } from "@/components/platform/event-sentences";
import { UNCERTAIN_EXPLANATION } from "@/components/platform/labels";
import type { PlatformEventType } from "@/lib/controlplane/types";
import { event } from "./fixtures";

/** Every event type the contract declares, so a new one cannot ship without a sentence. */
const ALL_TYPES: PlatformEventType[] = [
  "operation.proposed", "operation.prepared", "operation.approved", "operation.rejected", "operation.denied",
  "operation.started", "operation.succeeded", "operation.failed", "operation.uncertain", "operation.cancelled",
  "policy.evaluated", "workflow.started", "workflow.completed", "lease.acquired", "lease.lost", "lease.released",
  "credential.assumed", "credential.denied", "resource.planned", "resource.applying", "resource.applied",
  "resource.verified", "resource.observed", "deployment.healthy", "deployment.unhealthy", "drift.detected",
  "drift.cleared", "incident.opened", "incident.investigated", "incident.resolved", "remediation.proposed",
  "remediation.approved", "remediation.completed", "runner.registered", "runner.revoked", "runner.job.dispatched",
  "runner.job.completed", "machine.registered", "machine.revoked", "machine.request.completed",
];

describe("describeEvent", () => {
  it.each(ALL_TYPES)("%s has a human sentence that is not its code", (type) => {
    const d = describeEvent(event(type, { actor: { kind: "user", id: "u", name: "Riya Shah" } }));
    expect(d.sentence.length).toBeGreaterThan(10);
    expect(d.sentence).not.toContain(type);
    expect(d.sentence).not.toMatch(/\b[a-z]+\.[a-z]+\b/); // no dotted event code
    expect(d.sentence.endsWith(".")).toBe(true);
  });

  it("explains an uncertain operation in the agreed words", () => {
    expect(describeEvent(event("operation.uncertain")).sentence).toBe(UNCERTAIN_EXPLANATION);
    expect(UNCERTAIN_EXPLANATION).toBe(
      "Zenith cannot prove whether this change happened; reconciliation will observe the real state."
    );
  });

  it("names the actor, and falls back to Zenith", () => {
    expect(describeEvent(event("operation.approved", { actor: { kind: "user", id: "u", name: "Dev Patel" } })).sentence).toBe("Dev Patel approved this proposal.");
    expect(describeEvent(event("operation.proposed")).sentence).toBe("Zenith proposed this change.");
  });

  it("does not say 'verified' for a run that only finished or was applied", () => {
    expect(describeEvent(event("operation.succeeded")).sentence).not.toMatch(/verif/i);
    expect(describeEvent(event("resource.applied")).sentence).not.toMatch(/verif/i);
  });

  it("labels a simulated verification as simulated and never as success", () => {
    const real = describeEvent(event("resource.verified"));
    const sim = describeEvent(event("resource.verified", { data: { simulated: true } }));
    expect(real.tone).toBe("ok");
    expect(sim.simulated).toBe(true);
    expect(sim.tone).toBe("info");
    expect(sim.sentence).toContain("No real infrastructure was read");
  });

  it("uses the policy outcome when the event carries a known one", () => {
    expect(describeEvent(event("policy.evaluated", { data: { outcome: "require_approval" } })).sentence).toContain("approval");
    expect(describeEvent(event("policy.evaluated", { data: { outcome: "deny" } })).sentence).toBe("Policy blocked the request.");
    expect(describeEvent(event("policy.evaluated", { data: { outcome: "weird" } })).sentence).toBe("Policy evaluated the request.");
  });

  it("surfaces only string detail, bounded, with control characters removed", () => {
    const d = describeEvent(event("operation.failed", { data: { error: `boom\n${"x".repeat(1000)}` } }));
    expect(d.detail).toBeDefined();
    expect(d.detail!.length).toBeLessThanOrEqual(240);
    expect(d.detail).not.toMatch(/\n/);
    expect(describeEvent(event("operation.failed", { data: { error: { nested: true } } })).detail).toBeUndefined();
  });

  it("says plainly when the type is newer than this build", () => {
    const d = describeEvent(event("operation.proposed", { type: "brand.new.kind" as PlatformEventType }));
    expect(d.sentence).toContain("does not describe");
  });

  it("does not execute or interpret markup in data", () => {
    const d = describeEvent(event("operation.failed", { data: { message: "<img src=x onerror=alert(1)>" } }));
    expect(d.detail).toBe("<img src=x onerror=alert(1)>"); // kept as text; React escapes it
  });
});

describe("safeDataEntries", () => {
  it("lists scalars, skips secret-looking keys, nested values and caps the count", () => {
    const entries = safeDataEntries({ region: "ap-south-1", count: 3, ok: true, password: "x", api_token: "y", nested: { a: 1 }, n: null });
    expect(entries.map((e) => e.key)).toEqual(["region", "count", "ok"]);
    const many = safeDataEntries(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"])));
    expect(many).toHaveLength(12);
  });
});

describe("groupByCorrelation", () => {
  it("groups by correlation id in sequence order and orders groups by first event", () => {
    const a1 = event("operation.proposed", { correlationId: "A", seq: 1, id: "e1" });
    const b1 = event("incident.opened", { correlationId: "B", seq: 2, id: "e2" });
    const a2 = event("operation.approved", { correlationId: "A", seq: 3, id: "e3" });
    const groups = groupByCorrelation([a2, b1, a1]);
    expect(groups.map((g) => g.correlationId)).toEqual(["A", "B"]);
    expect(groups[0].events.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("drops a replayed duplicate and does not mutate its input", () => {
    const a = event("operation.proposed", { id: "dup", seq: 5 });
    const input = [a, { ...a }];
    const before = JSON.stringify(input);
    expect(groupByCorrelation(input)[0].events).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns no groups for no events", () => {
    expect(groupByCorrelation([])).toEqual([]);
  });
});
