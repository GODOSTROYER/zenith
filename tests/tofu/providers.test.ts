import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCKFILES } from "@/lib/tofu/locks.generated";
import { splitLockBlocks, assembleLockfile } from "@/lib/tofu/lockfile";
import {
  EMPTY_LOCKFILE,
  LOCK_PLATFORMS,
  PROVIDER_PINS,
  PROVIDER_SET_NAMES,
  PROVIDER_SET_PROVIDERS,
  lockfileSource,
  providerOfType,
  requiredProviders,
} from "@/lib/tofu/providers";

const locksDir = path.resolve(__dirname, "../../src/lib/tofu/locks");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("provider pins", () => {
  it("pins every provider to one exact stable version", () => {
    for (const [name, pin] of Object.entries(PROVIDER_PINS)) {
      expect(pin.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pin.source, name).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
    }
    expect(PROVIDER_PINS.aws.version.startsWith("6.")).toBe(true);
  });

  it("generates required_providers with exact `=` constraints", () => {
    const rp = requiredProviders(["random", "aws"]);
    expect(Object.keys(rp)).toEqual(["aws", "random"]);
    expect(rp.aws).toEqual({ source: "hashicorp/aws", version: `= ${PROVIDER_PINS.aws.version}` });
    expect(rp.random.version).toBe(`= ${PROVIDER_PINS.random.version}`);
  });

  it("maps resource types to provider prefixes", () => {
    expect(providerOfType("aws_ecs_service")).toBe("aws");
    expect(providerOfType("google_sql_database_instance")).toBe("google");
    expect(providerOfType("terraform_data")).toBe("terraform");
  });
});

describe("committed lockfiles", () => {
  it("has one lockfile per provider set, mirrored byte for byte into locks.generated.ts", () => {
    for (const set of PROVIDER_SET_NAMES) {
      const file = readFileSync(path.join(locksDir, `${set}.terraform.lock.hcl`), "utf8");
      expect(LOCKFILES[set], `${set} mirror`).toBeDefined();
      expect(lf(LOCKFILES[set]), `${set} mirror equals .hcl`).toBe(lf(file));
    }
  });

  it("locks exactly the pinned version of exactly the providers of each set", () => {
    for (const set of PROVIDER_SET_NAMES) {
      const blocks = splitLockBlocks(LOCKFILES[set]);
      const wanted = PROVIDER_SET_PROVIDERS[set];
      expect(blocks.map((b) => b.source).sort(), set).toEqual(wanted.map(lockfileSource).sort());
      for (const name of wanted) {
        const block = blocks.find((b) => b.source === lockfileSource(name))!;
        expect(block.version, `${set}/${name}`).toBe(PROVIDER_PINS[name].version);
        expect(block.constraints, `${set}/${name} constraints`).toBe(PROVIDER_PINS[name].version);
      }
    }
  });

  it("carries both h1: (per-platform package) and zh: (registry) hashes for every provider", () => {
    for (const set of PROVIDER_SET_NAMES) {
      for (const block of splitLockBlocks(LOCKFILES[set])) {
        const h1 = block.hashes.filter((h) => h.startsWith("h1:"));
        const zh = block.hashes.filter((h) => h.startsWith("zh:"));
        expect(h1.length, `${set} ${block.source} h1`).toBeGreaterThanOrEqual(LOCK_PLATFORMS.length);
        expect(zh.length, `${set} ${block.source} zh`).toBeGreaterThanOrEqual(LOCK_PLATFORMS.length);
        for (const h of h1) expect(h).toMatch(/^h1:[A-Za-z0-9+/]{43}=$/);
        for (const h of zh) expect(h).toMatch(/^zh:[0-9a-f]{64}$/);
      }
    }
  });

  it("the builtin set has an empty lockfile (terraform_data ships inside the binary)", () => {
    expect(LOCKFILES.builtin).toBe(EMPTY_LOCKFILE);
  });

  it("round-trips through split/assemble in tofu's own layout", () => {
    for (const set of PROVIDER_SET_NAMES) {
      expect(assembleLockfile(splitLockBlocks(LOCKFILES[set])), set).toBe(lf(LOCKFILES[set]));
    }
  });
});
