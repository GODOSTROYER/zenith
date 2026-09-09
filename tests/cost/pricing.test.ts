/**
 * The cost model is shown to users before every deploy and reported after it,
 * so the numbers are a product promise, not an implementation detail. These
 * assertions pin the actual figures — a silent edit to a table now fails here
 * rather than in someone's budget.
 */
import { describe, expect, it } from "vitest";
import type { Manifest, Resource, ResourceKind, Service, ServiceSize } from "@/lib/domain/types";
import { SIZE_SPECS, monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";

const SIZES: ServiceSize[] = ["nano", "small", "standard", "performance"];

const service = (over: Partial<Service> & Pick<Service, "id">): Service => ({
  name: "svc",
  kind: "web",
  source: { type: "image", image: "alpine:3" },
  size: "small",
  replicas: 1,
  env: [],
  ownership: "managed",
  ...over,
});

const resource = (over: Partial<Resource> & Pick<Resource, "id" | "kind">): Resource => ({
  name: "res",
  config: {},
  size: "small",
  ownership: "managed",
  ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  services: [],
  resources: [],
  routes: [],
  bindings: [],
  ...over,
});

describe("service cost", () => {
  it("charges the published rate per size", () => {
    const rates: Record<ServiceSize, number> = {
      nano: 3.5,
      small: 7,
      standard: 14,
      performance: 42,
    };
    for (const size of SIZES) {
      const m = manifest({ services: [service({ id: "s", size })] });
      expect(nodeMonthlyCostUsd(m, "s"), size).toBe(rates[size]);
    }
  });

  it("multiplies by replicas", () => {
    const m = manifest({ services: [service({ id: "s", size: "standard", replicas: 3 })] });
    expect(nodeMonthlyCostUsd(m, "s")).toBe(42);
  });

  it("bills a scaled-to-zero service as nothing", () => {
    // A service at 0 replicas runs nothing, so the estimate is $0; the
    // scale action's own warning already says it stops serving traffic.
    const m = manifest({ services: [service({ id: "s", size: "small", replicas: 0 })] });
    expect(nodeMonthlyCostUsd(m, "s")).toBe(0);
  });

  it("charges a cron 15% of its size, ignoring replicas", () => {
    const m = manifest({
      services: [service({ id: "s", kind: "cron", size: "performance", replicas: 4 })],
    });
    expect(nodeMonthlyCostUsd(m, "s")).toBeCloseTo(6.3, 10);
  });

  it("charges every static site a flat 1.5, whatever its size", () => {
    for (const size of SIZES) {
      const m = manifest({ services: [service({ id: "s", kind: "static", size, replicas: 5 })] });
      expect(nodeMonthlyCostUsd(m, "s"), size).toBe(1.5);
    }
  });

  it("gets more expensive as the size goes up", () => {
    const costs = SIZES.map((size) =>
      nodeMonthlyCostUsd(manifest({ services: [service({ id: "s", size })] }), "s")
    );
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(new Set(costs).size).toBe(SIZES.length);
  });
});

describe("resource cost", () => {
  const rates: Record<string, Record<ServiceSize, number>> = {
    postgres: { nano: 6, small: 12, standard: 26, performance: 78 },
    redis: { nano: 4, small: 8, standard: 18, performance: 50 },
    object_store: { nano: 1, small: 2.5, standard: 6, performance: 15 },
    queue: { nano: 1, small: 2, standard: 5, performance: 12 },
    email: { nano: 1, small: 3, standard: 8, performance: 20 },
  };

  it("charges the published rate per kind and size", () => {
    for (const [kind, bySize] of Object.entries(rates))
      for (const size of SIZES) {
        const m = manifest({ resources: [resource({ id: "r", kind: kind as ResourceKind, size })] });
        expect(nodeMonthlyCostUsd(m, "r"), `${kind}/${size}`).toBe(bySize[size]);
      }
  });

  it("prices every resource kind at every size", () => {
    // A kind missing from the table would silently cost 0.
    const kinds: ResourceKind[] = ["postgres", "redis", "object_store", "queue", "email"];
    for (const kind of kinds)
      for (const size of SIZES) {
        const m = manifest({ resources: [resource({ id: "r", kind, size })] });
        expect(nodeMonthlyCostUsd(m, "r"), `${kind}/${size}`).toBeGreaterThan(0);
      }
  });

  it("charges nothing for a resource Zenith does not manage", () => {
    for (const ownership of ["referenced", "external"] as const) {
      const m = manifest({
        resources: [resource({ id: "r", kind: "postgres", size: "performance", ownership })],
      });
      expect(nodeMonthlyCostUsd(m, "r"), ownership).toBe(0);
    }
  });
});

describe("route cost", () => {
  it("charges 0.5 per route", () => {
    const m = manifest({
      routes: [{ id: "rt", host: "a.example.com", pathPrefix: "/", tls: true, managedDns: true }],
    });
    expect(nodeMonthlyCostUsd(m, "rt")).toBe(0.5);
  });
});

describe("unknown nodes", () => {
  it("costs nothing rather than throwing", () => {
    expect(nodeMonthlyCostUsd(manifest(), "nope")).toBe(0);
  });
});

describe("monthlyCostUsd", () => {
  it("sums services, resources and routes", () => {
    const m = manifest({
      services: [
        service({ id: "web", size: "standard", replicas: 2 }), // 28
        service({ id: "site", kind: "static", size: "nano" }), // 1.5
      ],
      resources: [
        resource({ id: "db", kind: "postgres", size: "small" }), // 12
        resource({ id: "ext", kind: "redis", size: "performance", ownership: "referenced" }), // 0
      ],
      routes: [{ id: "rt", host: "a.example.com", pathPrefix: "/", tls: true, managedDns: true }], // 0.5
    });
    expect(monthlyCostUsd(m)).toBe(42);
  });

  it("rounds to whole cents", () => {
    // nano cron = 3.5 * 0.15 = 0.525, which must not reach the UI as $0.525.
    const m = manifest({ services: [service({ id: "c", kind: "cron", size: "nano" })] });
    expect(monthlyCostUsd(m)).toBe(0.53);
  });

  it("is zero for an empty manifest", () => {
    expect(monthlyCostUsd(manifest())).toBe(0);
  });

  it("equals the sum of its parts", () => {
    const m = manifest({
      services: [service({ id: "a", size: "performance", replicas: 3 }), service({ id: "b" })],
      resources: [
        resource({ id: "c", kind: "queue", size: "standard" }),
        resource({ id: "d", kind: "email", size: "nano" }),
      ],
      routes: [
        { id: "e", host: "a.example.com", pathPrefix: "/", tls: true, managedDns: true },
        { id: "f", host: "b.example.com", pathPrefix: "/api", tls: false, managedDns: false },
      ],
    });
    const parts = ["a", "b", "c", "d", "e", "f"].reduce(
      (sum, id) => sum + nodeMonthlyCostUsd(m, id),
      0
    );
    expect(monthlyCostUsd(m)).toBeCloseTo(parts, 10);
  });
});

describe("SIZE_SPECS", () => {
  it("covers every size", () => {
    for (const size of SIZES) expect(SIZE_SPECS[size], size).toBeDefined();
  });

  it("grows monotonically, so a bigger size is never a smaller machine", () => {
    for (let i = 1; i < SIZES.length; i++) {
      const prev = SIZE_SPECS[SIZES[i - 1]];
      const next = SIZE_SPECS[SIZES[i]];
      expect(next.vcpu, SIZES[i]).toBeGreaterThan(prev.vcpu);
      expect(next.memoryMb, SIZES[i]).toBeGreaterThan(prev.memoryMb);
    }
  });

  it("publishes the exact figures the inspector shows", () => {
    expect(SIZE_SPECS).toEqual({
      nano: { vcpu: 0.25, memoryMb: 256 },
      small: { vcpu: 0.5, memoryMb: 512 },
      standard: { vcpu: 1, memoryMb: 1024 },
      performance: { vcpu: 2, memoryMb: 4096 },
    });
  });
});
