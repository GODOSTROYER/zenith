/**
 * Contract-level tests of the mixed-cloud evidence verifier. The plan views are CANNED
 * (shaped like GET /api/platform/v1/mixed/plans/:id), not observed from a real run;
 * they prove the verifier accepts complete evidence and refuses every kind of gap.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchPlanView, verifyMixedEvidence, type LivePlanChild, type LivePlanView } from "../../scripts/acceptance/mixed-evidence";

const h = (n: number): string => String(n).repeat(64).slice(0, 64);

function child(ordinal: number, provider: string): LivePlanChild {
  return {
    partitionId: `partition/p${ordinal}`, ordinal, childEnvironmentId: `env-${provider}`, dependsOn: ordinal === 0 ? [] : [`partition/p${ordinal - 1}`],
    subplanDigest: h(ordinal + 1), semanticsDigest: h(ordinal + 2),
    partition: { provider, accountId: `acct-${provider}`, region: "r-1", backendKind: "s3", backendDigest: h(ordinal + 3), connectionId: `conn-${provider}`, connectionIdentityDigest: h(ordinal + 4) },
    nodes: [{ stableAddress: `${provider}:r-1:abc::service/${provider}`, address: `service/${provider}` }],
    state: "succeeded", childOperationId: `op_${ordinal}`, executableSemanticsDigest: h(ordinal + 5),
    receipt: { outcome: "succeeded", childOperationId: `op_${ordinal}`, ordinal, executableSemanticsDigest: h(ordinal + 5), receiptDigest: h(ordinal + 6) },
  };
}

function view(over: Partial<LivePlanView> = {}): LivePlanView {
  const children = [child(0, "azure"), child(1, "gcp"), child(2, "aws")];
  return {
    parentPlanId: "mpp_x", status: "succeeded", parentOperationId: "op_parent", childSetDigest: h(7), executionOrder: children.map((c) => c.partitionId),
    teardownOrder: children.map((c) => c.partitionId).reverse(), children, ...over,
  };
}

describe("mixed-cloud evidence verifier (canned views)", () => {
  it("accepts complete, consistent evidence and says what it does not establish", () => {
    const verdict = verifyMixedEvidence(view());
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.limits.join(" ")).toMatch(/does not read any cloud/);
  });

  it.each([
    ["an unfinished plan", () => view({ status: "running" }), /not succeeded/],
    ["no parent operation", () => view({ parentOperationId: null }), /no parent operation/],
    ["a malformed child set digest", () => view({ childSetDigest: "nope" }), /child set digest/],
    ["a wrong teardown order", () => view({ teardownOrder: ["partition/p0", "partition/p1", "partition/p2"] }), /reverse/],
    ["a single child", () => { const only = [child(0, "aws")]; return view({ children: only, executionOrder: ["partition/p0"], teardownOrder: ["partition/p0"] }); }, /at least two/],
  ])("refuses %s", (_name, make, expected) => {
    const verdict = verifyMixedEvidence(make());
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(expected);
  });

  it("refuses every kind of child gap", () => {
    const mutate = (fn: (children: LivePlanChild[]) => void): string => {
      const v = view(); fn(v.children); const out = verifyMixedEvidence(v); expect(out.ok).toBe(false); return out.problems.join("\n");
    };
    expect(mutate((c) => { c[1].state = "failed"; })).toMatch(/Child 2 is failed/);
    expect(mutate((c) => { c[1].receipt = null; })).toMatch(/Child 2 has no durable receipt/);
    expect(mutate((c) => { c[1].receipt!.outcome = "uncertain"; })).toMatch(/receipt says uncertain/);
    expect(mutate((c) => { c[1].receipt!.childOperationId = "op_other"; })).toMatch(/different operation/);
    expect(mutate((c) => { c[1].executableSemanticsDigest = null; })).toMatch(/no reviewed executable semantics/);
    expect(mutate((c) => { c[1].receipt!.executableSemanticsDigest = h(9); })).toMatch(/disagree/);
    expect(mutate((c) => { c[1].partition.backendDigest = c[0].partition.backendDigest; })).toMatch(/share a state backend/);
    expect(mutate((c) => { c[1].partition.connectionIdentityDigest = c[0].partition.connectionIdentityDigest; })).toMatch(/share a connection identity/);
    expect(mutate((c) => { c[2].partition.provider = "azure"; c[1].partition.provider = "azure"; })).toMatch(/at least two providers/);
    expect(mutate((c) => { c[1].dependsOn = ["partition/p2"]; })).toMatch(/did not run before/);
    expect(mutate((c) => { c[1].nodes[0].stableAddress = c[0].nodes[0].stableAddress; })).toMatch(/appears twice/);
    expect(mutate((c) => { c[1].nodes[0].stableAddress = "gcp:r-1:abc::service/other"; })).toMatch(/does not name it/);
  });

  it("refuses unreadable input rather than passing it", () => {
    for (const bad of [null, undefined, 3, "x", {}, { children: "no" }]) expect(verifyMixedEvidence(bad).ok).toBe(false);
  });
});

describe("fetchPlanView", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-mixed-evidence-"));
  const tokenFile = path.join(dir, "token");
  writeFileSync(tokenFile, "opaque-token-canary\n");

  it("reads the token from a file, sends it only as a bearer header and never echoes it in an error", async () => {
    const seen: { url: string; auth: string | null; workspace: string | null }[] = [];
    const ok = (async (url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ url: String(url), auth: headers.get("authorization"), workspace: headers.get("x-zenith-workspace") });
      return new Response(JSON.stringify(view()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const body = await fetchPlanView({ apiUrl: "https://control.example", workspaceId: "ws-1", planId: "mpp_x", tokenFile, fetchImpl: ok });
    expect(verifyMixedEvidence(body).ok).toBe(true);
    expect(seen).toEqual([{ url: "https://control.example/api/platform/v1/mixed/plans/mpp_x", auth: "Bearer opaque-token-canary", workspace: "ws-1" }]);
    const denied = (async () => new Response(JSON.stringify({ error: { message: "opaque-token-canary" } }), { status: 403 })) as unknown as typeof fetch;
    const failure = await fetchPlanView({ apiUrl: "https://control.example", workspaceId: "ws-1", planId: "mpp_x", tokenFile, fetchImpl: denied }).catch((error: Error) => error);
    expect((failure as Error).message).toBe("The control plane answered 403.");
  });

  it("refuses a plain-http remote control plane and an empty token file", async () => {
    await expect(fetchPlanView({ apiUrl: "http://control.example", workspaceId: "ws-1", planId: "mpp_x", tokenFile })).rejects.toThrow(/https/);
    const empty = path.join(dir, "empty");
    writeFileSync(empty, "\n");
    await expect(fetchPlanView({ apiUrl: "https://control.example", workspaceId: "ws-1", planId: "mpp_x", tokenFile: empty })).rejects.toThrow(/empty/);
  });
});
