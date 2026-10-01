/** Client behavior with fake HTTP/action replies, not browser/cloud acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentTeardownReview } from "@/app/(product)/platform/environments/[id]/environment-teardown-review";
import { mount, button, click, flush, text } from "./render";

const mocks = vi.hoisted(() => ({ api: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: mocks.api, executeAction: mocks.execute }));
beforeEach(() => { mocks.api.mockReset().mockResolvedValue({ review: null }); mocks.execute.mockReset(); });
afterEach(() => vi.restoreAllMocks());
const props = { workspaceId: "ws-a", environmentId: "env-a", viewerRole: "viewer" as const };
const digest = "a".repeat(64);
describe("first teardown review UI", () => {
  it("a viewer requests only the read-only action and sees the recorded pending proposal", async () => {
    const el = mount(<EnvironmentTeardownReview {...props} />); await flush();
    mocks.execute.mockResolvedValue({ ok: true, data: { reviewOperationId: "op-review" } });
    mocks.api.mockResolvedValue({ review: { reviewOperationId: "op-review", operationId: "op-destroy", status: "awaiting_approval", planDigest: digest, planReview: { planDigest: digest } } });
    click(button(el, "Review teardown")); await flush();
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("env.reviewTeardown", expect.objectContaining({ input: expect.objectContaining({ environmentId: "env-a", idempotencyKey: expect.any(String) }) }));
    expect(text(el)).toContain("awaiting human approval"); expect(text(el)).toContain(digest);
    expect(el.querySelector('a[href="/platform/operations/op-destroy"]')).toBeTruthy();
    expect(text(el)).not.toContain("Approve teardown");
  });
  it("restores a recorded review on reload and warns when the PlanView is absent", async () => {
    mocks.api.mockResolvedValue({ review: { reviewOperationId: "op-review", operationId: "op-destroy", status: "awaiting_approval", planDigest: digest } });
    const el = mount(<EnvironmentTeardownReview {...props} />); await flush();
    expect(text(el)).toContain("recorded PlanView is unavailable"); expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledWith("/api/platform/v1/environments/env-a/teardown-review", expect.objectContaining({ headers: { "x-zenith-workspace": "ws-a" }, credentials: "same-origin" }));
  });
  it("blocks duplicate clicks while the request is in progress", async () => {
    const el = mount(<EnvironmentTeardownReview {...props} />); await flush();
    let settle!: (value: unknown) => void; mocks.execute.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    click(button(el, "Review teardown")); click(button(el, "Review teardown"));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    settle({ ok: false }); await flush(); expect(text(el)).toContain("could not be confirmed");
  });
  it("keeps external errors out of the UI and retains the same key after a lost reply", async () => {
    const el = mount(<EnvironmentTeardownReview {...props} />); await flush();
    mocks.execute.mockRejectedValue(new Error("Bearer secret-canary"));
    click(button(el, "Review teardown")); await flush();
    const key = mocks.execute.mock.calls[0][1].input.idempotencyKey;
    expect(text(el)).not.toContain("secret-canary");
    click(button(el, "Review teardown")); await flush();
    expect(mocks.execute.mock.calls[1][1].input.idempotencyKey).toBe(key);
  });
  it("requires membership and disables requests while a recorded review is running", async () => {
    const noMember = mount(<EnvironmentTeardownReview {...props} viewerRole="none" />); await flush();
    expect(button(noMember, "Review teardown").disabled).toBe(true); expect(mocks.api).not.toHaveBeenCalled();
    mocks.api.mockResolvedValue({ review: { reviewOperationId: "op-review", status: "running" } });
    const running = mount(<EnvironmentTeardownReview {...props} />); await flush();
    expect(button(running, "Review teardown").disabled).toBe(true); expect(text(running)).toContain("running");
  });
});
