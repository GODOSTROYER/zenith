import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { assertRunId, assertRunTagged, assertTaggedForRun, assertWithinBudget, establishLiveSession, liveRunName, liveRunTags, newRunId, resolveLiveTarget, runIdTime, TAG_LIVE_RUN } from "../../scripts/acceptance/safety";
import { ACCOUNT, access, config, RUN } from "./_helpers";

const sts = mockClient(STSClient), ssm = mockClient(SSMClient), tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterEach(() => { sts.reset(); ssm.reset(); tagging.reset(); });
const establish = (over: Partial<Parameters<typeof establishLiveSession>[0]> = {}) => establishLiveSession({ config: config(), access: access(), mutating: true, confirmBillable: true, runId: RUN, ...over });
function bootstrap() { sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT }); ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "true" } }); }
describe("sandbox safety (AWS calls are mocked)", () => {
  it.each([
    [{ awsAccountId: undefined }, "account_unset"], [{ awsAccountId: "bad" }, "account_malformed"],
    [{ region: undefined }, "region_unset"], [{ region: "moon-1" }, "region_not_allowed"], [{ maxMonthlyUsd: 0 }, "budget_invalid"],
  ] as const)("refuses invalid target %j before AWS", (over, code) => {
    expect(() => resolveLiveTarget({ ...config(), ...over })).toThrow(expect.objectContaining({ code })); expect(sts.calls()).toHaveLength(0); expect(ssm.calls()).toHaveLength(0);
  });
  it("refuses the wrong caller account without reading the marker", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "999999999999" });
    await expect(establish()).rejects.toMatchObject({ code: "account_mismatch" }); expect(ssm.calls()).toHaveLength(0);
  });
  it.each([["ParameterNotFound", "marker_missing"], ["AccessDeniedException", "marker_unreadable"]])("refuses %s marker read", async (name, code) => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT }); ssm.on(GetParameterCommand).rejects(Object.assign(new Error("read failed"), { name }));
    await expect(establish()).rejects.toMatchObject({ code });
  });
  it.each(["false", "TRUE", " true", ""])("refuses marker %j", async (value) => {
    bootstrap(); ssm.on(GetParameterCommand).resolves({ Parameter: { Value: value } }); await expect(establish()).rejects.toMatchObject({ code: "marker_not_true" });
  });
  it("refuses unconfirmed mutation before even STS", async () => {
    await expect(establish({ confirmBillable: false })).rejects.toMatchObject({ code: "confirm_required" }); expect(sts.calls()).toHaveLength(0);
  });
  it.each([undefined, Number.NaN, -1, Number.POSITIVE_INFINITY])("refuses unknown cost %s", (cost) => { expect(() => assertWithinBudget(cost, 50)).toThrow(expect.objectContaining({ code: "cost_unknown" })); });
  it("refuses an over-budget plan and accepts the boundary", () => { expect(() => assertWithinBudget(50.01, 50)).toThrow(expect.objectContaining({ code: "cost_exceeds_budget" })); expect(() => assertWithinBudget(50, 50)).not.toThrow(); });
  it.each([undefined, {}, { [TAG_LIVE_RUN]: "zlive-202609301200-xxxx" }] as (Record<string, string> | undefined)[])("refuses a resource outside this run %j", (tags) => { expect(() => assertRunTagged(tags, RUN, "database")).toThrow(expect.objectContaining({ code: "not_run_tagged" })); });
  it("refuses a resource absent from the tag index", async () => { tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] }); await expect(assertTaggedForRun(access().client(ResourceGroupsTaggingAPIClient), "arn:aws:s3:::test", RUN)).rejects.toMatchObject({ code: "tag_unverifiable" }); });
  it("generates UTC ids, validates dates and restricts names", () => {
    const id = newRunId(new Date("2026-09-30T12:34:59Z"), () => Uint8Array.of(0, 1, 2, 35));
    expect(id).toBe("zlive-202609301234-abc9"); expect(runIdTime(id)?.toISOString()).toBe("2026-09-30T12:34:00.000Z");
    expect(runIdTime("zlive-202602301200-ab12")).toBeNull(); expect(runIdTime("zlive-202613011200-ab12")).toBeNull();
    expect(() => assertRunId("bad")).toThrow(); expect(liveRunName(RUN, "web")).toBe(`zenith-${RUN}-web`); expect(() => liveRunName(RUN, "../../bad")).toThrow(); expect(liveRunTags(RUN)[TAG_LIVE_RUN]).toBe(RUN);
  });
  it("establishes with exactly STS + SSM and requires a cost before creation", async () => {
    bootstrap(); const session = await establish(); expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1); expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1); expect(tagging.calls()).toHaveLength(0);
    expect(ssm.call(0).args[0].input).toEqual({ Name: "/zenith/live-sandbox", WithDecryption: false });
    expect(() => session.assertMutationAllowed("create", { needsCost: true })).toThrow(); session.checkCost(40); expect(() => session.assertMutationAllowed("create", { needsCost: true })).not.toThrow();
    const readOnly = await establish({ mutating: false, confirmBillable: false }); expect(() => readOnly.assertMutationAllowed("delete", { needsCost: false })).toThrow();
  });
});
