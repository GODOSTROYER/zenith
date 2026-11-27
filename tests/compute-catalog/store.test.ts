import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeCatalog, SourceEvidence } from "@/lib/compute-catalog/types";
import { ComputeCatalogUnavailableError, ComputeCatalogValidationError, loadComputeCatalog, parseComputeCatalog, parseRawComputeSnapshots, readBoundedJson, saveComputeCatalog } from "@/lib/compute-catalog/store";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function fixture(): ComputeCatalog {
  const source: SourceEvidence = { kind: "aws_ec2_prices", url: "https://pricing.us-east-1.amazonaws.com/example.json", retrievedAt: "2026-11-27T00:00:00Z" };
  return {
    schemaVersion: 1, version: "test.1", generatedAt: "2026-11-27T00:00:00Z", sources: [source],
    coverage: [{ provider: "aws", regions: ["ap-south-1"], offerCount: 1, pricedOfferCount: 1, scope: "imported_snapshots", warnings: [] }], warnings: [],
    offers: [{ id: "aws/ap-south-1/test", provider: "aws", region: "ap-south-1", instanceType: "test", vcpus: 4, memoryMiB: 16384,
      architecture: "x86_64", cpuMode: "sustained", operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
      price: { hourlyUsd: "0.123456789012", source }, specSource: source, offeringState: "catalog_only", warnings: [] }],
  };
}

describe("operator compute catalog store", () => {
  it("preserves decimal prices and requires exact coverage counts", () => {
    expect(parseComputeCatalog(fixture()).offers[0].price?.hourlyUsd).toBe("0.123456789012");
    const bad = fixture(); bad.coverage[0].pricedOfferCount = 0;
    expect(() => parseComputeCatalog(bad)).toThrow("Coverage counts");
  });

  it("rejects duplicate native offers even when their ids differ", () => {
    const bad = fixture(); bad.offers.push({ ...bad.offers[0], id: "another-id" });
    expect(() => parseComputeCatalog(bad)).toThrow("Duplicate offer");
  });

  it("rejects unknown evidence, foreign sources, and future effective prices", () => {
    const bad = fixture(); bad.offers[0].price!.source = { ...bad.sources[0], retrievedAt: "2026-11-26T00:00:00Z" };
    expect(() => parseComputeCatalog(bad)).toThrow("absent from the catalog");
    const foreign = fixture(); foreign.sources[0].kind = "azure_retail_prices";
    expect(() => parseComputeCatalog(foreign)).toThrow("different provider");
    const future = fixture(); future.offers[0].price!.effectiveAt = "2026-12-01T00:00:00Z";
    expect(() => parseComputeCatalog(future)).toThrow("future effective price");
  });

  it("rejects credential-bearing evidence URLs", () => {
    for (const url of ["http://prices.azure.com/example", "https://user:secret@example.com/file", "https://cloudbilling.googleapis.com/v1/services?key=secret", "https://example.com/?client_secret=secret", "https://example.com/?X-Goog-Signature=secret", "https://example.com/?X-Amz-Security-Token=secret"]) {
      const bad = fixture(); bad.sources[0].url = url;
      expect(() => parseComputeCatalog(bad)).toThrow("Source must be HTTPS");
    }
  });

  it("refuses a missing import document or unknown envelope fields", () => {
    const source = fixture().sources[0];
    expect(() => parseRawComputeSnapshots({ schemaVersion: 1, snapshots: [source] })).toThrow();
    expect(() => parseRawComputeSnapshots({ schemaVersion: 1, snapshots: [{ ...source, data: {} }], live: true })).toThrow();
    expect(parseRawComputeSnapshots({ schemaVersion: 1, snapshots: [{ ...source, data: { products: {} } }] })).toHaveLength(1);
  });

  it("publishes atomically and retains the previous catalog on validation failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-store-")); dirs.push(dir);
    const path = join(dir, "catalog.json");
    await expect(loadComputeCatalog(path)).rejects.toBeInstanceOf(ComputeCatalogUnavailableError);
    await saveComputeCatalog(fixture(), path);
    const original = await readFile(path, "utf8");
    const bad = fixture(); bad.offers[0].price!.hourlyUsd = "NaN";
    await expect(saveComputeCatalog(bad, path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await loadComputeCatalog(path)).version).toBe("test.1");
  });

  it("bounds reads and rejects invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-read-")); dirs.push(dir);
    const path = join(dir, "input.json");
    await writeFile(path, "{\"long\":true}");
    await expect(readBoundedJson(path, 5)).rejects.toThrow("no larger");
    await writeFile(path, "not json");
    await expect(readBoundedJson(path)).rejects.toThrow("not valid JSON");
  });

  it("shares a validated immutable catalog across concurrent and repeated readers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-cache-")); dirs.push(dir);
    const path = join(dir, "catalog.json");
    await saveComputeCatalog(fixture(), path);
    const readers = await Promise.all(Array.from({ length: 8 }, () => loadComputeCatalog(path)));
    const first = readers[0]!;
    expect(readers.every(result => result === first)).toBe(true);
    expect(await loadComputeCatalog(path)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.offers)).toBe(true);
    expect(Object.isFrozen(first.offers[0]!.price!.source)).toBe(true);
    expect(() => { first.offers[0]!.price!.hourlyUsd = "0"; }).toThrow(TypeError);
    expect(() => first.offers[0]!.warnings.push("Changed by another request")).toThrow(TypeError);
    expect((await loadComputeCatalog(path)).offers[0]!.price!.hourlyUsd).toBe("0.123456789012");
  });

  it("observes an external atomic replacement even when size and mtime are preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-replace-")); dirs.push(dir);
    const path = join(dir, "catalog.json"), replacement = join(dir, "replacement.json");
    await saveComputeCatalog(fixture(), path);
    const first = await loadComputeCatalog(path);
    const before = await stat(path);
    const next = fixture(); next.version = "test.2";
    await writeFile(replacement, `${JSON.stringify(next, null, 2)}\n`);
    await utimes(replacement, before.atime, before.mtime);
    expect((await stat(replacement)).size).toBe(before.size);
    await rename(replacement, path);
    const current = await loadComputeCatalog(path);
    expect(current.version).toBe("test.2");
    expect(current).not.toBe(first);
    expect(await loadComputeCatalog(path)).toBe(current);
    next.version = "test.3";
    await saveComputeCatalog(next, path);
    expect((await loadComputeCatalog(path)).version).toBe("test.3");
  });

  it("rejects a malformed replacement instead of returning an older cached success, then recovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-invalid-cache-")); dirs.push(dir);
    const path = join(dir, "catalog.json"), replacement = join(dir, "replacement.json");
    await saveComputeCatalog(fixture(), path);
    await loadComputeCatalog(path);
    await writeFile(replacement, "not valid JSON");
    await rename(replacement, path);
    await expect(loadComputeCatalog(path)).rejects.toBeInstanceOf(ComputeCatalogValidationError);
    await expect(loadComputeCatalog(path)).rejects.toBeInstanceOf(ComputeCatalogValidationError);
    const valid = fixture(); valid.version = "recovered";
    await saveComputeCatalog(valid, path);
    expect((await loadComputeCatalog(path)).version).toBe("recovered");
  });

  it("does not hide a removed catalog behind the cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-missing-cache-")); dirs.push(dir);
    const path = join(dir, "catalog.json");
    await saveComputeCatalog(fixture(), path);
    await loadComputeCatalog(path);
    await rm(path);
    await expect(loadComputeCatalog(path)).rejects.toBeInstanceOf(ComputeCatalogUnavailableError);
    const next = fixture(); next.version = "restored";
    await saveComputeCatalog(next, path);
    expect((await loadComputeCatalog(path)).version).toBe("restored");
  });

  it("bounds retained catalog paths while keeping recently used identities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-compute-cache-bound-")); dirs.push(dir);
    const entries: { path: string; value: ComputeCatalog }[] = [];
    for (let index = 0; index < 5; index++) {
      const path = join(dir, `catalog-${index}.json`);
      await saveComputeCatalog(fixture(), path);
      entries.push({ path, value: await loadComputeCatalog(path) });
    }
    const recent = entries.at(-1)!;
    expect(await loadComputeCatalog(recent.path)).toBe(recent.value);
    const evicted = await loadComputeCatalog(entries[0]!.path);
    expect(evicted).not.toBe(entries[0]!.value);
    expect(evicted).toEqual(entries[0]!.value);
  });
});
