/**
 * `planView` tells a UI WHY a value is absent: `sensitive: true` for
 * attributes the plan marked sensitive (render "(sensitive)"), nothing for
 * values merely withheld from the model-safe view. The value itself is never
 * present in either case.
 */
import { describe, expect, it } from "vitest";
import { planView } from "@/lib/tofu/plan";
import type { NormalizedPlan } from "@/lib/tofu/types";

const plan: NormalizedPlan = {
  tofuVersion: "1.12.5",
  formatVersion: "1.2",
  configDigest: "c".repeat(64),
  lockDigest: "l".repeat(64),
  planDigest: "p".repeat(64),
  resourceChanges: [
    {
      address: "aws_db_instance.db",
      nodeAddress: "postgres/db",
      type: "aws_db_instance",
      providerName: "registry.opentofu.org/hashicorp/aws",
      action: "update",
      destroysData: false,
      changes: [
        { path: "password", before: "(sensitive)", after: "(sensitive)", sensitive: true, forcesReplacement: false, fingerprint: "f".repeat(64) },
        { path: "instance_class", before: "db.t4g.micro", after: "db.t4g.small", sensitive: false, forcesReplacement: false },
      ],
    },
  ],
  outputChanges: [],
  summary: { create: 0, update: 1, delete: 0, replace: 0, noop: 0 },
  empty: false,
  diagnostics: [],
  createdAt: "2026-09-30T00:00:00.000Z",
};

describe("planView sensitive flag", () => {
  it("flags sensitive attributes without exposing their values or fingerprints", () => {
    const view = planView(plan);
    const changes = view.resources[0].changes;
    const password = changes.find((c) => c.path === "password");
    const klass = changes.find((c) => c.path === "instance_class");
    expect(password).toEqual({ path: "password", forcesReplacement: false, sensitive: true });
    expect(klass).toMatchObject({ before: "db.t4g.micro", after: "db.t4g.small" });
    expect(klass?.sensitive).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("f".repeat(64));
  });
});
