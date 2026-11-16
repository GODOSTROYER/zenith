/**
 * PROD-DUR-07 operator surface (UX-01): the effects panel, its browser actions and the live journey in jsdom.
 * HTTP replies are test fakes, not live API evidence; the routes themselves are covered in routes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dom from "../screens/platform/render";
import { button, click, flush, mount, text } from "../screens/platform/render";
import { EffectsPanel } from "@/components/platform/effects-panel";
import { EffectsActions } from "@/app/(product)/platform/operations/[id]/effects-actions";
import { readJourney } from "@/app/(product)/platform/_components/journey-live";
import { buildReadback, resolutionBinding } from "@/lib/effects/binding";
import { effectView } from "@/lib/effects/view";
import type { EffectRecord } from "@/lib/effects/types";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/platform" }));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); router.refresh.mockReset(); vi.stubGlobal("fetch", fetchMock); });
const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.now();
function record(over: Partial<EffectRecord> = {}): EffectRecord {
  return {
    workspaceId: "ws_1", effectId: "fx_1", family: "build_launch", operationId: "op_1", environmentId: "env_1", provider: "aws", dedupKey: "build:op_1:svc",
    requestDigest: "a".repeat(64), target: {}, idempotencyToken: "zn-1", idempotencySupported: true, fenceScope: "env:env_1", fenceEpoch: 3,
    state: "uncertain", stateReason: "The provider call ended without a confirmed outcome.", providerReceipt: null, lateReceipt: null, readback: null, tombstoneReason: null,
    version: 4, createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), uncertainAt: new Date(NOW - 3_000_000).toISOString(), ...over,
  };
}
const present = () => buildReadback({ outcome: "present", source: "aws.codebuild.list-builds", observedAt: new Date(NOW).toISOString(), resourceId: "zn:00000000-0000-4000-8000-000000000001", facts: { matches: 1 } });
const absent = () => buildReadback({ outcome: "absent", source: "aws.codebuild.list-builds", observedAt: new Date(NOW).toISOString(), facts: { matches: 0 } });

describe("EffectsPanel", () => {
  it("renders nothing when an operation has no external effects", () => {
    expect(text(mount(<EffectsPanel effects={[]} viewerRole="admin" />))).toBe("");
  });

  it("says plainly that an uncertain effect will not be retried, and offers no retry control", () => {
    const el = mount(<EffectsPanel effects={[effectView(record(), { fenceLive: false })]} viewerRole="viewer" />);
    expect(text(el)).toContain("Outcome uncertain");
    expect(text(el)).toContain("1 change needs your review");
    expect(text(el)).toMatch(/will not retry/);
    expect(el.querySelector("section")?.getAttribute("aria-labelledby")).toBeTruthy();
    for (const b of el.querySelectorAll("button")) expect(text(b).toLowerCase()).not.toContain("retry");
    expect(text(el)).toContain("Only a workspace admin, signed in through the browser");
  });

  it("an editor may run the read-only readback but cannot resolve", async () => {
    const onReadback = vi.fn(async () => undefined);
    const el = mount(<EffectsPanel effects={[effectView(record(), { fenceLive: false })]} viewerRole="editor" onReadback={onReadback} />);
    click(button(el, "Read back from the provider")); await flush();
    expect(onReadback).toHaveBeenCalledWith("fx_1");
    expect([...el.querySelectorAll("button")].map(text).join("|")).not.toContain("Confirm it");
  });

  it("an admin sees the evidence and can confirm only what it supports, with a written reason", async () => {
    const withReadback = record({ readback: present() });
    const onResolve = vi.fn(async () => undefined);
    const el = mount(<EffectsPanel effects={[effectView(withReadback, { fenceLive: false })]} viewerRole="admin" onResolve={onResolve} onReadback={async () => undefined} />);
    expect(text(el)).toContain("found it");
    expect(text(el)).toContain("aws.codebuild.list-builds");
    const applied = button(el, "Confirm it happened");
    const notApplied = button(el, "Confirm it did not happen");
    expect(applied.disabled).toBe(true); // no reason yet
    expect(notApplied.disabled).toBe(true); // the evidence does not support it
    expect(text(el)).toMatch(/Not available: Readback found the effect/);
    const reason = el.querySelector("textarea")!;
    dom.type(reason, "The console shows exactly one build for this launch.");
    expect(button(el, "Confirm it happened").disabled).toBe(false);
    expect(button(el, "Confirm it did not happen").disabled).toBe(true);
    click(button(el, "Confirm it happened")); await flush();
    expect(onResolve).toHaveBeenCalledWith({ effectId: "fx_1", decision: "confirm_applied", bindingDigest: resolutionBinding(withReadback, "confirm_applied", withReadback.readback!.digest), reason: "The console shows exactly one build for this launch." });
  });

  it("explains why absence cannot be confirmed while the dispatching lease is live", () => {
    const el = mount(<EffectsPanel effects={[effectView(record({ readback: absent() }), { fenceLive: true })]} viewerRole="admin" onResolve={async () => undefined} />);
    expect(text(el)).toMatch(/still live/);
    expect(button(el, "Confirm it did not happen").disabled).toBe(true);
  });

  it("shows a tombstone that received a late provider receipt as a conflict that needs review", () => {
    const late = { requestIds: ["x"], resourceId: "late-1", receivedAt: new Date(NOW).toISOString(), staleFence: true, digest: "d".repeat(64) };
    const el = mount(<EffectsPanel effects={[effectView(record({ state: "tombstoned", tombstoneReason: "provider_rejected", lateReceipt: late }), { fenceLive: false })]} viewerRole="viewer" />);
    expect(text(el)).toContain("Evidence conflicts");
    expect(text(el)).toContain("later answered");
    expect(text(el)).toContain("late-1");
    expect(text(el)).toContain("after the lease was gone");
  });

  it("never prints the provider token", () => {
    const el = mount(<EffectsPanel effects={[effectView(record({ idempotencyToken: "zn-token-canary" }), { fenceLive: false })]} viewerRole="admin" />);
    expect(el.innerHTML).not.toContain("zn-token-canary");
    expect(text(el)).toContain("sent");
  });
});

describe("EffectsActions (browser routes)", () => {
  it("posts the readback to the effects route with the workspace header, then refreshes", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ effect: {} }));
    const el = mount(<EffectsActions effects={[effectView(record(), { fenceLive: false })]} viewerRole="editor" workspaceId="ws_1" />);
    click(button(el, "Read back from the provider")); await flush(); await flush();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe("/api/platform/v1/effects/fx_1/readback");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-zenith-workspace")).toBe("ws_1");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("posts the reviewed binding and reason on resolution", async () => {
    const withReadback = record({ readback: present() });
    fetchMock.mockResolvedValueOnce(jsonReply({ effect: {} }));
    const el = mount(<EffectsActions effects={[effectView(withReadback, { fenceLive: false })]} viewerRole="admin" workspaceId="ws_1" />);
    dom.type(el.querySelector("textarea")!, "Confirmed in the console.");
    click(button(el, "Confirm it happened")); await flush(); await flush();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe("/api/platform/v1/effects/fx_1/resolve");
    expect(JSON.parse(String(init?.body))).toEqual({ decision: "confirm_applied", bindingDigest: resolutionBinding(withReadback, "confirm_applied", withReadback.readback!.digest), reason: "Confirmed in the console." });
  });

  it("words a refusal for people without echoing the server's message", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ error: { code: "digest_mismatch", message: "SERVER-DETAIL-CANARY" } }, 409));
    const el = mount(<EffectsActions effects={[effectView(record(), { fenceLive: false })]} viewerRole="editor" workspaceId="ws_1" />);
    click(button(el, "Read back from the provider")); await flush(); await flush();
    expect(text(el)).toContain("changed or this decision was already recorded");
    expect(el.innerHTML).not.toContain("SERVER-DETAIL-CANARY");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("live journey keeps unresolved effects", () => {
  const op = (status: string) => ({ operation: { id: "op_1", status, planDigest: "a".repeat(64), proposalDigest: "b".repeat(64) } });
  it("a poll of a failed operation stays uncertain while the server render says an effect is uncertain", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply(op("failed")));
    const view = await readJourney("ws_1", { kind: "platform_operation", operationId: "op_1" }, undefined, [{ effectId: "fx_1", state: "uncertain", familyLabel: "Build launch" }]);
    expect(view.stage).toBe("uncertain");
    expect(view.outcomeKnown).toBe(false);
    expect(view.nextSteps.join(" ")).toMatch(/Do not retry/);
  });
  it("without effects it is the unchanged projection", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply(op("failed")));
    expect((await readJourney("ws_1", { kind: "platform_operation", operationId: "op_1" })).stage).toBe("failed");
  });
});
