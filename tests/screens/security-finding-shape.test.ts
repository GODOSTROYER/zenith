/**
 * What the Security screen actually receives from the rule engine, for the
 * three rules the screen renders in a special way: the two production policy
 * findings (fixable, and their fix lives in Settings → Environments) and the
 * resource-config secret (no automatic fix, so the row offers a map link and
 * "No auto-fix" rather than a button that would fail).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEnvironmentPolicy, matches, NO_FILTERS } from "@/app/(product)/p/[slug]/security/rows";
import { emptyManifest, type Environment, type Project } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-rules-"));

const { analyze } = await import("@/lib/security/rules");

const project = (): Project => ({
  id: "p1",
  workspaceId: "ws",
  name: "Atlas",
  slug: "atlas",
  createdAt: "2026-09-01T00:00:00.000Z",
  origin: { type: "blank" },
  workingManifest: {
    ...emptyManifest(),
    resources: [
      {
        id: "res_cache",
        name: "cache",
        kind: "redis",
        size: "small",
        ownership: "managed",
        config: { password: "s3cr3t-not-a-placeholder", maxmemory: 256 },
      },
    ],
  },
});

const prod: Environment = {
  id: "env_prod",
  projectId: "p1",
  name: "production",
  class: "production",
  connectionId: "cx1",
  region: "us-east-1",
  baseDomain: "atlas.orrery.test",
  createdAt: "2026-09-01T00:00:00.000Z",
  policies: { approvalRequired: false, allowStatefulDeletion: true },
};

const found = analyze(project(), [prod]);
const byRule = (rule: string) => found.find((f) => f.id.startsWith(`sf_${rule}_`));

describe("production policy findings", () => {
  it("offers env.updatePolicies as the fix and points at the screen that owns it", () => {
    for (const rule of ["prod_no_approval", "prod_stateful_deletion"]) {
      const f = byRule(rule);
      expect(f, rule).toBeDefined();
      expect(f!.severity).toBe("high");
      expect(f!.environmentId).toBe("env_prod");
      expect(f!.fix?.actionId).toBe("env.updatePolicies");
      expect(isEnvironmentPolicy(f!)).toBe(true);
      // The environment filter and the header highlight both key off this.
      expect(matches(f!, { ...NO_FILTERS, environmentId: "env_prod" })).toBe(true);
      expect(matches(f!, { ...NO_FILTERS, environmentId: "none" })).toBe(false);
    }
  });

  it("sends the budget finding to the same place", () => {
    const budget = byRule("no_budget_prod");
    expect(budget?.fix?.actionId).toBe("env.setBudget");
    expect(isEnvironmentPolicy(budget!)).toBe(true);
  });
});

describe("secret-shaped value in a resource config", () => {
  const f = byRule("plaintext_config_secret");

  it("is reported against the resource, with no automatic fix to offer", () => {
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.title).toContain("cache.config.password");
    expect(f!.targetId).toBe("res_cache"); // the row's "show on map" link
    expect(f!.fix).toBeUndefined();
    expect(matches(f!, { ...NO_FILTERS, fix: "manual" })).toBe(true);
    expect(matches(f!, { ...NO_FILTERS, fix: "fixable" })).toBe(false);
  });

  it("ignores config values that are not secrets and keys that are not secret-shaped", () => {
    expect(found.filter((x) => x.id.startsWith("sf_plaintext_config_secret_"))).toHaveLength(1);
  });
});
