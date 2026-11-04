/**
 * discover(): candidates only. Never `managed`, never adopted; Zenith's own
 * objects are hinted with `zenithTagged`; dead objects and unreadable listings
 * produce nothing rather than guesses.
 */
import { describe, expect, it } from "vitest";
import { ociDrivers } from "@/lib/providers/oci/drivers";
import { driverContext, err, expandOci, FakeOci, json, ocid, zenithTagsFor } from "./_support";
import { healthyWorld } from "./_world";

const graph = expandOci();
const discoverable = ociDrivers.filter((d) => d.discover);

describe("discovery", () => {
  it("lists what is in the compartment as candidates, with the Zenith hint, sorted by id", async () => {
    const world = healthyWorld(graph);
    const ctx = driverContext(world.oci);
    const seen = new Set<string>();
    for (const d of discoverable) {
      const found = await d.discover!(ctx);
      for (const c of found) {
        seen.add(d.nativeType);
        expect(c).toMatchObject({ provider: "oci", nativeType: d.nativeType, kind: d.kind, region: "us-ashburn-1" });
        expect(typeof c.externalId).toBe("string");
        expect(c.name.length).toBeGreaterThan(0);
        expect(Object.values(c.attributes).every((v) => ["string", "number", "boolean"].includes(typeof v))).toBe(true);
        expect(c).not.toHaveProperty("ownership");
      }
      expect(found.map((c) => c.externalId)).toEqual([...found.map((c) => c.externalId)].sort());
    }
    // the stack has an instance of every discoverable type except volumes and registries
    expect([...seen].sort()).toEqual(expect.arrayContaining(["oci:vcn", "oci:subnet", "oci:load_balancer", "oci:container_instance", "oci:postgresql_db_system", "oci:object_storage_bucket", "oci:queue", "oci:vault_secret", "oci:log_group", "oci:redis_cluster", "oci:certificate", "oci:dns_zone"]));
  });

  it("flags Zenith-tagged objects and leaves strangers untagged (a hint, not adoption)", async () => {
    const stranger = { id: ocid("subnet", "stranger"), lifecycleState: "AVAILABLE", displayName: "theirs", cidrBlock: "10.9.0.0/24", freeformTags: { owner: "someone" } };
    const mine = { id: ocid("subnet", "mine"), lifecycleState: "AVAILABLE", displayName: "ours", cidrBlock: "10.0.0.0/24", freeformTags: zenithTagsFor("subnet/public-a") };
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([stranger, mine]));
    const subnet = ociDrivers.find((d) => d.nativeType === "oci:subnet")!;
    const found = await subnet.discover!(driverContext(oci));
    const byId = [mine, stranger].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(found.map((f) => [f.externalId, f.zenithTagged])).toEqual(byId.map((o) => [o.id, o === mine]));
  });

  it("skips terminated objects and objects without an id", async () => {
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([{ id: ocid("subnet", "dead"), lifecycleState: "TERMINATED" }, { lifecycleState: "AVAILABLE" }, { id: ocid("subnet", "live"), lifecycleState: "AVAILABLE", displayName: "live" }]));
    const subnet = ociDrivers.find((d) => d.nativeType === "oci:subnet")!;
    expect((await subnet.discover!(driverContext(oci))).map((f) => f.name)).toEqual(["live"]);
  });

  it.each([403, 429, 503])("an unreadable listing (HTTP %i) yields no candidates, not an exception", async (status) => {
    const oci = new FakeOci().on(() => err(status, "Nope"));
    for (const d of discoverable) expect(await d.discover!(driverContext(oci)), d.id).toEqual([]);
  });

  it("only GET requests are ever made", async () => {
    const world = healthyWorld(graph);
    for (const d of discoverable) await d.discover!(driverContext(world.oci));
    expect(world.oci.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
