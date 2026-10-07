import { describe, expect, it, vi } from "vitest";
import { ApprovalCard, type ApprovalCardProps } from "@/components/platform/approval-card";
import { approval, decision, DIGEST, DIGEST_2, EARLIER, NOW, operation, planView, PLAN_DIGEST } from "./fixtures";
import { button, buttons, click, describedBy, flush, headingsDoNotSkip, mount, nameOf, text, type as typeInto } from "./render";

const approver = { id: "user_other", role: "admin" as const };
const SEMANTICS_DIGEST = "9".repeat(64);

function props(over: Partial<ApprovalCardProps> = {}): ApprovalCardProps {
  return {
    operation: operation(),
    decision: decision(),
    approvals: [],
    viewer: approver,
    capabilityTitle: "Apply an infrastructure plan",
    scopeNames: { workspace: "Acme", project: "Storefront", environment: "Production" },
    plan: planView(),
    semanticsDigest: SEMANTICS_DIGEST,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    now: NOW,
    ...over,
  };
}

describe("<ApprovalCard> content", () => {
  it("shows the capability title, the proposal summary and the details", () => {
    const el = mount(<ApprovalCard {...props()} />);
    expect(el.querySelector("h3")?.textContent).toBe("Apply an infrastructure plan");
    expect(text(el)).toContain("Apply the reviewed plan to production");
    expect(text(el)).toContain("Changes the web service to 3 tasks");
    expect(text(el)).toContain("Replaces the database instance");
  });

  it("falls back to a readable title, not the capability code", () => {
    const el = mount(<ApprovalCard {...props({ capabilityTitle: undefined })} />);
    expect(el.querySelector("h3")?.textContent).toBe("Infrastructure apply");
  });

  it("shows the scope as workspace > project > environment, using names", () => {
    const el = mount(<ApprovalCard {...props()} />);
    const crumbs = [...el.querySelectorAll('nav[aria-label="Scope"] li')].map(text);
    expect(crumbs).toEqual(["Acme", "Storefront", "Production"]);
    expect(el.querySelector('nav[aria-label="Scope"] li[aria-current="location"]')?.textContent).toBe("Production");
  });

  it("falls back to ids, and includes the resource, when names are not known", () => {
    const op = operation({
      proposal: { ...operation().proposal, scope: { workspaceId: "ws_1", projectId: "proj_1", environmentId: "env_prod", resourceId: "res_db" } },
    });
    const el = mount(<ApprovalCard {...props({ operation: op, scopeNames: undefined })} />);
    expect([...el.querySelectorAll('nav[aria-label="Scope"] li')].map(text)).toEqual(["ws_1", "proj_1", "env_prod", "res_db"]);
  });

  it("shows the risk in words", () => {
    const el = mount(<ApprovalCard {...props()} />);
    expect(text(el)).toContain("high");
    const critical = mount(<ApprovalCard {...props({ operation: operation({ proposal: { ...operation().proposal, risk: "critical" } }) })} />);
    expect(text(critical)).toContain("critical");
  });

  it("labels the cost delta as an estimate", () => {
    const el = mount(<ApprovalCard {...props()} />);
    expect(text(el)).toContain("Cost change (estimate)");
    expect(text(el)).toContain("+$18.50");
    expect(text(el)).toContain("not an invoice");
  });

  it("says when no estimate exists instead of showing $0", () => {
    const op = operation({ proposal: { ...operation().proposal, costDeltaUsd: undefined } });
    const el = mount(<ApprovalCard {...props({ operation: op })} />);
    expect(text(el)).toContain("Not estimated for this proposal");
    expect(text(el)).not.toContain("$0.00");
  });

  it("summarises the plan and calls out data destruction by name", () => {
    const el = mount(<ApprovalCard {...props()} />);
    expect(text(el)).toContain("1 to create");
    expect(text(el)).toContain("1 to replace");
    const callout = [...el.querySelectorAll('[role="alert"]')].find((c) => text(c).includes("destroys data"));
    expect(callout).toBeDefined();
    expect(text(callout!)).toContain("aws_db_instance.main");
    expect(text(callout!)).toContain("rollback cannot restore");
  });

  it("shows the policy reasons as sentences and keeps the code in a disclosure", () => {
    const el = mount(<ApprovalCard {...props()} />);
    expect(text(el)).toContain("Environment autonomy level 2 is below the level (5)");
    const disclosure = [...el.querySelectorAll("details")].find((d) => text(d).includes("Rule codes"));
    expect(disclosure?.textContent).toContain("autonomy_below_capability");
    // the code is not in the visible paragraph text
    expect([...el.querySelectorAll("li")].filter((li) => !li.closest("details")).map(text).join(" ")).not.toContain("autonomy_below_capability");
  });

  it("states the approval requirement: count, minimum role and the two-person rule", () => {
    const d = decision({ approval: { count: 2, minRole: "admin", separationOfDuties: true } });
    const el = mount(<ApprovalCard {...props({ decision: d, approvals: [approval({ approver: { kind: "user", id: "u1", name: "One" } })] })} />);
    expect(text(el)).toContain("2 different people");
    expect(text(el)).toContain("admin role or higher");
    expect(text(el)).toContain("cannot be one of them");
    expect(text(el)).toContain("1 of 2 approved");
  });

  it("shows a short digest with a button that copies the whole one", () => {
    const el = mount(<ApprovalCard {...props()} />);
    const code = [...el.querySelectorAll("code")].find((c) => c.getAttribute("title") === DIGEST);
    expect(code?.textContent).toBe(`${DIGEST.slice(0, 12)}…`);
    expect(nameOf(button(el, "Copy proposal digest"))).toBe("Copy proposal digest");
    expect(el.innerHTML).not.toContain(`>${DIGEST}<`); // the full digest is not printed, only carried in title and the copy action
  });

  it("shows the reviewed executable semantics digest and explains what the approval binds", () => {
    const el = mount(<ApprovalCard {...props()} />);
    const code = [...el.querySelectorAll("code")].find((c) => c.getAttribute("title") === SEMANTICS_DIGEST);
    expect(code?.textContent).toBe(`${SEMANTICS_DIGEST.slice(0, 12)}…`);
    expect(nameOf(button(el, "Copy executable semantics digest"))).toBe("Copy executable semantics digest");
    expect(text(el)).toContain("Your approval binds the exact revision, build recipe, scripts, migration class, targets, configuration, provider locks and state backend");
  });

  it("counts down to expiry, and says so when it has passed", () => {
    const soon = mount(<ApprovalCard {...props()} />);
    expect(text(soon)).toContain("in 40 minutes");
    const gone = mount(<ApprovalCard {...props({ operation: operation({ expiresAt: EARLIER }) })} />);
    expect(text(gone)).toContain("Expired 1 hour ago");
  });

  it("names who asked, including the human behind an agent", () => {
    const el = mount(<ApprovalCard {...props({ operation: operation({ principal: { kind: "integration", id: "i1", name: "Codex", onBehalfOf: "user_owner" } }) })} />);
    expect(text(el)).toContain("Codex (an integration, for user_owner)");
  });

  it("keeps heading order", () => {
    expect(headingsDoNotSkip(mount(<ApprovalCard {...props()} />))).toBe(true);
  });
});

describe("<ApprovalCard> decisions", () => {
  it("offers Approve and Reject, enabled, to an eligible viewer, with named buttons", () => {
    const el = mount(<ApprovalCard {...props()} />);
    const approve = button(el, "Approve");
    const reject = button(el, "Reject");
    expect(approve.disabled).toBe(false);
    expect(reject.disabled).toBe(false);
    expect(nameOf(approve)).toBe("Approve Apply an infrastructure plan");
    expect(nameOf(reject)).toBe("Reject Apply an infrastructure plan");
    // an eligible viewer is not shown a "you cannot" sentence
    expect(text(el)).not.toContain("cannot approve");
  });

  it("sends the approval with the digest the viewer reviewed and an optional reason", async () => {
    const onApprove = vi.fn();
    const el = mount(<ApprovalCard {...props({ onApprove })} />);
    typeInto(el.querySelector("textarea")!, "  Reviewed the plan and the rollback notes.  ");
    click(button(el, "Approve"));
    await flush();
    expect(onApprove).toHaveBeenCalledWith({ operationId: "op_1", proposalDigest: DIGEST, planDigest: PLAN_DIGEST, semanticsDigest: SEMANTICS_DIGEST, reason: "Reviewed the plan and the rollback notes." });
  });

  it("sends a rejection without a reason when none was typed", async () => {
    const onReject = vi.fn();
    const el = mount(<ApprovalCard {...props({ onReject })} />);
    click(button(el, "Reject"));
    await flush();
    expect(onReject).toHaveBeenCalledWith({ operationId: "op_1", proposalDigest: DIGEST });
  });

  it("ignores a second click while the first decision is in flight", async () => {
    let resolve!: () => void;
    const onApprove = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const el = mount(<ApprovalCard {...props({ onApprove })} />);
    const approve = button(el, "Approve");
    click(approve);
    click(approve);
    click(button(el, "Reject"));
    await flush();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(button(el, "Reject").disabled).toBe(true);
    resolve();
    await flush();
  });

  it("shows a failed decision under the buttons and lets the viewer try again", async () => {
    const onApprove = vi.fn().mockRejectedValueOnce(new Error("The proposal changed; reload to review it.")).mockResolvedValue(undefined);
    const el = mount(<ApprovalCard {...props({ onApprove })} />);
    click(button(el, "Approve"));
    await flush();
    expect(text(el)).toContain("The proposal changed; reload to review it.");
    expect(button(el, "Approve").disabled).toBe(false);
    click(button(el, "Approve"));
    await flush();
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(text(el)).not.toContain("The proposal changed");
  });

  it("shows an error the host passes in", () => {
    const el = mount(<ApprovalCard {...props({ actionError: "You no longer have access to this environment." })} />);
    expect(text(el)).toContain("You no longer have access to this environment.");
  });

  type Blocked = { name: string; over: () => Partial<ApprovalCardProps>; says: string };
  const BLOCKED: Blocked[] = [
    { name: "a viewer role", over: () => ({ viewer: { id: "user_v", role: "viewer" } }), says: "needs the editor role or higher" },
    { name: "the requester under the two-person rule", over: () => ({ viewer: { id: "user_requester", role: "admin" } }), says: "You requested this change" },
    { name: "an expired proposal", over: () => ({ operation: operation({ expiresAt: EARLIER }) }), says: "has expired" },
    { name: "a proposal that moved after opening", over: () => ({ viewer: { ...approver, reviewedDigest: DIGEST_2 } }), says: "changed after you opened it" },
    { name: "a viewer who already approved", over: () => ({ approvals: [approval()], decision: decision({ approval: { count: 2, minRole: "editor", separationOfDuties: true } }) }), says: "You already approved" },
    { name: "an operation that is not awaiting approval", over: () => ({ operation: operation({ status: "running" }) }), says: "not waiting for a decision" },
    { name: "a missing policy decision", over: () => ({ decision: undefined }), says: "not available" },
  ];

  it.each(BLOCKED)("$name: both buttons are disabled and the reason is visible and linked", ({ over, says }) => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const el = mount(<ApprovalCard {...props({ onApprove, onReject, ...over() })} />);
    const approve = button(el, "Approve");
    const reject = button(el, "Reject");
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    for (const b of [approve, reject]) {
      expect(describedBy(b)).toContain(says);
      expect(b.getAttribute("title")).toContain(says);
    }
    expect(text(el)).toContain(says); // visible text, not only a tooltip
    click(approve);
    click(reject);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(el.querySelector("textarea")).toBeNull(); // no input that cannot be used
  });

  it("blocks a decision when the plan shown is not the plan the proposal is bound to", () => {
    const el = mount(<ApprovalCard {...props({ plan: planView({ planDigest: "f".repeat(64) }) })} />);
    expect(button(el, "Approve").disabled).toBe(true);
    expect(text(el)).toContain("does not match the plan this proposal is bound to");
    expect(PLAN_DIGEST).not.toBe("f".repeat(64));
  });

  it("does not offer a decision while loading or after a failed load, and says why", () => {
    const loading = mount(<ApprovalCard {...props({ loading: true })} />);
    expect(button(loading, "Approve").disabled).toBe(true);
    expect(text(loading)).toContain("Waiting for the latest details");
    expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();

    const onRetry = vi.fn();
    const failed = mount(<ApprovalCard {...props({ error: "The proposal could not be loaded.", onRetry })} />);
    expect(button(failed, "Approve").disabled).toBe(true);
    expect(text(failed)).toContain("The proposal could not be loaded.");
    click(button(failed, "Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("every button has an accessible name", () => {
    const el = mount(<ApprovalCard {...props()} />);
    for (const b of buttons(el)) expect(nameOf(b).length).toBeGreaterThan(0);
  });
});


describe("approved source plan review",()=>{
  const sources=[{service:"container_service/web",commit:"a".repeat(40),dockerfileDigest:"d".repeat(64),recipeDigest:"e".repeat(64),archiveDigest:"f".repeat(64),archiveFormat:"zip" as const}];
  it("shows immutable commit/recipe/archive evidence and submits the matching bound normalized digest",async()=>{
    const onApprove=vi.fn(),plan={...planView(),executableSourceDigest:"c".repeat(64),approvedSources:sources};
    const el=mount(<ApprovalCard {...props({plan,onApprove})}/>);expect(text(el)).toContain("retained source commits");expect(text(el)).toContain(sources[0].commit);expect(text(el)).toContain("Dockerfile");expect(text(el)).toContain("Source archive (zip)");
    await click(button(el,"Approve Apply an infrastructure plan"));await flush();expect(onApprove).toHaveBeenCalledWith({operationId:"op_1",planDigest:plan.planDigest,proposalDigest:DIGEST,semanticsDigest:SEMANTICS_DIGEST});
  });
  it("source metadata never lets a mismatched plan digest bypass human review",()=>{
    const onApprove=vi.fn(),plan={...planView(),planDigest:DIGEST_2,executableSourceDigest:"c".repeat(64),approvedSources:sources};
    const el=mount(<ApprovalCard {...props({plan,onApprove})}/>);expect(button(el,"Approve Apply an infrastructure plan").disabled).toBe(true);expect(onApprove).not.toHaveBeenCalled();expect(text(el)).toContain("does not match");
  });
});


describe("canonical repository source review to browser [scoped SQL model]",()=>{
  it("withPlanReview preserves source details which the browser human reviews with the plan digest",async()=>{
    const {withPlanReview}=await import("@/lib/controlplane/db/repos/operation-review");const {extractPlanFacts}=await import("@/lib/policy/plan-facts");const {makePlan}=await import("../../execution/fakes/fixtures");
    const {immutableSourceSnapshot,sourceSnapshotDigest,sourceSnapshotSetDigest}=await import("@/lib/execution/source-snapshot");
    const native=immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId:"ws_1",operationId:"op_1",projectId:"proj_1",environmentId:"env_prod",
      serviceAddress:"container_service/web",serviceSpecDigest:"a".repeat(64),pipelineAddress:"build_pipeline/web",pipelineSpecDigest:"b".repeat(64),provider:"aws",region:"us-east-1",owner:"acme",repo:"app",repositoryId:99,requestedRef:"main",commitSha:"a".repeat(40),githubBinding:null,dockerfile:"Dockerfile",dockerfileDigest:"d".repeat(64),recipeDigest:"e".repeat(64),archiveFormat:"zip",archiveDigest:"f".repeat(64),archiveBytes:100});
    const plan={...planView(),executableSourceDigest:sourceSnapshotSetDigest([native]),approvedSources:[{service:native.serviceAddress,commit:native.commitSha,dockerfileDigest:native.dockerfileDigest,recipeDigest:native.recipeDigest,archiveDigest:native.archiveDigest,archiveFormat:native.archiveFormat}]};
    const summary={stage:"plan",planDigest:plan.planDigest,executableSourceDigest:plan.executableSourceDigest,view:plan,facts:extractPlanFacts(makePlan()),cost:{}};
    const sql={query:vi.fn(async(query:string,params?:readonly unknown[])=>{
      if(query.startsWith("select summary"))return [{summary}];
      expect(query).toContain("from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2");expect(params).toEqual([native.workspaceId,native.operationId]);return [{snapshot:native,snapshot_digest:sourceSnapshotDigest(native)}];
    }),exec:async()=>undefined,tx:async()=>{throw new Error("Read-only SQL projection model.");}};
    const op=await withPlanReview(sql as never,{...operation(),approvalRound:0});expect(sql.query.mock.calls).toHaveLength(2);const onApprove=vi.fn();
    const el=mount(<ApprovalCard {...props({operation:op,plan:op.planReview?.view,onApprove})}/>);expect(text(el)).toContain("Retained commit");expect(text(el)).toContain("a".repeat(40));
    click(button(el,"Approve Apply an infrastructure plan"));await flush();expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({planDigest:PLAN_DIGEST}));
  });
});
