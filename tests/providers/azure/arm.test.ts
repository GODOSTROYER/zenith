import { afterEach, describe, expect, it } from "vitest";
import { armClient, armResourceId, armTypeOf, ArmError, inSubscription, parseArmId, pollOperation, safeText } from "@/lib/providers/azure/arm";
import { fakeArm, fakeEntra, sessionFor, SUB, type ArmRoute, type FakeArm } from "./_helpers";

const open: FakeArm[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
async function setup(routes: ArmRoute[]) {
  const arm = await fakeArm(routes, fakeEntra());
  open.push(arm);
  return { arm, session: await sessionFor(arm) };
}

describe("ARM ids", () => {
  const id = `/subscriptions/${SUB}/resourceGroups/My-RG/providers/Microsoft.Network/virtualNetworks/vnet1/subnets/s1`;
  it("parses, types and compares case-insensitively", () => {
    expect(parseArmId(id)).toMatchObject({ subscriptionId: SUB, resourceGroup: "My-RG", provider: "Microsoft.Network", segments: [{ type: "virtualnetworks", name: "vnet1" }, { type: "subnets", name: "s1" }] });
    expect(armTypeOf(id)).toBe("microsoft.network/virtualnetworks/subnets");
    expect(inSubscription(id, SUB.toUpperCase())).toBe(true);
    expect(inSubscription(id, "99999999-9999-9999-9999-999999999999")).toBe(false);
    expect(parseArmId(`/subscriptions/${SUB}`)).toMatchObject({ subscriptionId: SUB, segments: [] });
  });
  it("rejects anything that is not an ARM id", () => {
    for (const bad of ["", "/", "subscriptions/x", "/subscriptions/not-a-guid/resourceGroups/x", `/subscriptions/${SUB}/resourceGroups`, `/subscriptions/${SUB}/garbage/x`, `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.X/t`]) {
      expect(parseArmId(bad), bad).toBeUndefined();
    }
  });
  it("builds ids from validated segments only", () => {
    expect(armResourceId(SUB, "rg", "Microsoft.Cache", [["redis", "r1"]])).toBe(`/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Cache/redis/r1`);
    expect(() => armResourceId(SUB, "rg/../x", "Microsoft.Cache", [["redis", "r1"]])).toThrow();
    expect(() => armResourceId(SUB, "rg", "Microsoft.Cache", [["redis", "r1?x=y"]])).toThrow();
    expect(() => armResourceId("nope", "rg", "Microsoft.Cache", [["redis", "r1"]])).toThrow();
  });
});

describe("ARM client", () => {
  it("classifies every status the drivers care about, carrying the request id and Retry-After", async () => {
    const cases: [number, string, Record<string, string>][] = [
      [404, "not_found", {}],
      [401, "forbidden", {}],
      [403, "forbidden", {}],
      [429, "throttled", { "retry-after": "12" }],
      [409, "conflict", {}],
      [412, "conflict", {}],
      [500, "server", {}],
      [503, "server", {}],
      [400, "client", {}],
    ];
    for (const [status, kind, headers] of cases) {
      const { session } = await setup([{ match: () => true, status, headers, body: { error: { code: "Some.Code", message: "went wrong" } } }]);
      const e = await armClient(session).get("/subscriptions/x", { apiVersion: "2024-01-01" }).catch((x) => x);
      expect(e, String(status)).toBeInstanceOf(ArmError);
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expect(e.armCode).toBe("Some.Code");
      expect(e.requestId).toBe("req-fake-1");
      if (kind === "throttled") expect(e.retryAfterSec).toBe(12);
    }
  });

  it("scrubs token-shaped text from error messages and bounds their length", async () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4In0.c2lnbmF0dXJlc2lnbmF0dXJl";
    const { session } = await setup([{ match: () => true, status: 400, body: { error: { code: "Bad", message: `bad token ${jwt} and Bearer abcdefghijklmnop and AccountKey=SECRET123 ${"x".repeat(1000)}` } } }]);
    const e = await armClient(session).get("/x", { apiVersion: "1" }).catch((x) => x);
    expect(e.message).not.toContain(jwt);
    expect(e.message).not.toContain("abcdefghijklmnop");
    expect(e.message).not.toContain("SECRET123");
    expect(e.message.length).toBeLessThan(450);
    expect(safeText("a\n\nb   c")).toBe("a b c");
  });

  it("refuses paths that could escape the ARM origin", async () => {
    const { arm, session } = await setup([{ match: () => true, body: {} }]);
    const client = armClient(session);
    for (const p of ["subscriptions/x", "/a/../b", "/a//b", "/a b", "/a#frag", "/a\\b"]) await expect(client.get(p, { apiVersion: "1" })).rejects.toMatchObject({ kind: "client" });
    expect(arm.requests).toHaveLength(0);
  });

  it("follows nextLink within ARM only, and stops at the page bound", async () => {
    let page = 0;
    const { arm, session } = await setup([
      {
        match: (p) => p === "/things",
        handler: ({ query }) => {
          const n = Number(query.get("page") ?? 0);
          page++;
          return { status: 200, body: { value: [{ n }], nextLink: `https://management.azure.com/things?api-version=1&page=${n + 1}` } };
        },
      },
    ]);
    const r = await armClient(session).list("/things", { apiVersion: "1" }, 3);
    expect(r.items).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    expect(r.truncated).toBe(true);
    expect(page).toBe(3);
    expect(arm.requests).toHaveLength(3);

    const evil = await setup([{ match: () => true, body: { value: [{ n: 1 }], nextLink: "https://evil.example/steal?api-version=1" } }]);
    await expect(armClient(evil.session).list("/things", { apiVersion: "1" })).rejects.toMatchObject({ kind: "bad_response" });
    expect(evil.arm.requests).toHaveLength(1);
  });

  it("rejects an oversized or non-JSON body, and honours an abort", async () => {
    const big = await setup([{ match: () => true, handler: () => ({ status: 200, raw: `{"x":"${"a".repeat(3 * 1024 * 1024)}"}` }) }]);
    await expect(armClient(big.session).get("/x", { apiVersion: "1" })).rejects.toMatchObject({ kind: "bad_response" });
    const junk = await setup([{ match: () => true, handler: () => ({ status: 200, raw: "<html>" }) }]);
    await expect(armClient(junk.session).get("/x", { apiVersion: "1" })).rejects.toMatchObject({ kind: "bad_response" });
    const ac = new AbortController();
    ac.abort();
    await expect(armClient(big.session, ac.signal).get("/x", { apiVersion: "1" })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("sends JSON bodies with content-type and api-version, and never a caller-supplied credential", async () => {
    const { arm, session } = await setup([{ match: () => true, body: {} }]);
    await armClient(session).patch("/x", { apiVersion: "2024-03-01", body: { a: 1 }, headers: { authorization: "Bearer evil-evil-evil-evil" } });
    expect(arm.requests[0]).toMatchObject({ method: "PATCH", body: '{"a":1}' });
    expect(arm.requests[0].query.get("api-version")).toBe("2024-03-01");
    expect(arm.requests[0].authorization).not.toContain("evil");
  });
});

describe("pollOperation", () => {
  const OP = "/subscriptions/x/providers/Microsoft.App/locations/westeurope/containerappOperationResults/op";
  const headers = { "azure-asyncoperation": `https://management.azure.com${OP}?api-version=2024-03-01` };

  it("succeeds immediately when the call was not asynchronous", async () => {
    const { session } = await setup([]);
    expect(await pollOperation(session, { status: 200, headers: new Headers() })).toEqual({ state: "succeeded", requestIds: [] });
  });

  it("polls until a terminal state, bounded", async () => {
    let n = 0;
    const { session } = await setup([{ match: OP, handler: () => ({ status: 200, body: { status: ++n >= 3 ? "Succeeded" : "InProgress" } }) }]);
    expect((await pollOperation(session, { status: 202, headers: new Headers(headers) }, { intervalMs: 1 })).state).toBe("succeeded");
    expect(n).toBe(3);
    const slow = await setup([{ match: OP, body: { status: "InProgress" } }]);
    expect((await pollOperation(slow.session, { status: 202, headers: new Headers(headers) }, { intervalMs: 1, maxPolls: 3 })).state).toBe("pending");
    expect(slow.arm.requests).toHaveLength(3);
  });

  it("reports failure detail, and never polls a URL outside management.azure.com", async () => {
    const f = await setup([{ match: OP, body: { status: "Failed", error: { message: "boom" } } }]);
    expect(await pollOperation(f.session, { status: 202, headers: new Headers(headers) }, { intervalMs: 1 })).toMatchObject({ state: "failed", detail: "boom" });
    const off = await setup([]);
    expect(await pollOperation(off.session, { status: 202, headers: new Headers({ location: "https://evil.example/op?api-version=1" }) })).toMatchObject({ state: "unknown" });
    expect(off.arm.requests).toHaveLength(0);
  });
});
