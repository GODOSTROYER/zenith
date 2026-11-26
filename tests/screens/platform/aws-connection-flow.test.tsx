import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AwsConnectionFlow, CHECK_INTERVAL_MS } from "@/app/(product)/platform/connections/aws/aws-flow";
import { ApiError } from "@/lib/client/api";
import { button, click, flush, mount, text, type as typeInto } from "./render";

const { mutation } = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock("@/app/(product)/platform/_lib/browser-api", () => ({ browserMutation: mutation, mutationError: () => "Request failed." }));
beforeEach(() => mutation.mockReset());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const field = (el: Element, label: string) => {
  const target = [...el.querySelectorAll("label")].find((item) => text(item).startsWith(label))!;
  return document.getElementById(target.getAttribute("for")!) as HTMLInputElement;
};
const manual = (el: Element) => el.querySelector("details")!;

const LAUNCH_URL = "https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=x";
const created = (url?: string) => ({
  result: { ok: true, data: {
    connectionId: "conn-quick", subject: "zenith:ws:ws-test:conn:conn-quick", issuerHost: "tryzenith.cloud/api/oidc", mode: "oidc_web_identity",
    accountId: "123456789012", region: "us-east-1", bootstrapNameSuffix: "-zabc12345",
    launch: { stackName: "zenith-connection-zabc12345", parameters: { ZenithIssuerHost: "tryzenith.cloud/api/oidc", ZenithOidcSubject: "zenith:ws:ws-test:conn:conn-quick", CreateOidcProvider: "yes", NameSuffix: "-zabc12345" }, ...(url ? { url } : {}) },
  } },
});

it("connects with only the account ID, opens the prefilled AWS page and checks the connection by itself", async () => {
  vi.useFakeTimers();
  const open = vi.fn();
  vi.stubGlobal("open", open);
  mutation.mockResolvedValueOnce(created(LAUNCH_URL));
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" launch={{ oneClickReady: true }} />);
  expect(button(el, "Connect AWS").disabled).toBe(true);
  typeInto(field(el, "AWS account ID"), "1234 5678 9012");
  expect(button(el, "Connect AWS").disabled).toBe(false);
  click(button(el, "Connect AWS"));
  await flush();
  expect(mutation).toHaveBeenCalledWith("ws-test", "/platform/connections/aws/action", expect.objectContaining({ actionId: "connection.createAws", input: { accountId: "123456789012", region: "us-east-1" } }));

  click(button(el, "Open AWS to create the stack"));
  expect(open).toHaveBeenCalledWith(LAUNCH_URL, "_blank", "noopener,noreferrer");
  expect(text(el)).toContain("Waiting for the stack");

  mutation.mockResolvedValueOnce({ result: { ok: false, summary: "AWS verification failed." } });
  await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); });
  expect(mutation).toHaveBeenLastCalledWith("ws-test", "/platform/connections/aws/action", { actionId: "connection.verifyAws", input: { connectionId: "conn-quick" } });
  expect(text(el)).toContain("check 1 of");

  mutation.mockResolvedValueOnce({ result: { ok: true, summary: "Observe-role identity verified." } });
  await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); });
  expect(text(el)).toContain("AWS connected");
  const calls = mutation.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3); });
  expect(mutation.mock.calls.length).toBe(calls); // stops once connected
});

it("shows the exact values to enter when one-click is not enabled", async () => {
  mutation.mockResolvedValueOnce(created());
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  expect(text(el)).toContain("One-click setup is not enabled");
  typeInto(field(el, "AWS account ID"), "123456789012");
  click(button(el, "Connect AWS"));
  await flush();
  const rows = [...el.querySelectorAll("tbody tr")].map(text);
  expect(rows.find((row) => row.startsWith("NameSuffix"))).toContain("-zabc12345");
  expect(rows.find((row) => row.startsWith("ZenithOidcSubject"))).toContain("zenith:ws:ws-test:conn:conn-quick");
  expect(text(el)).toContain("zenith-connection-zabc12345");
  expect(() => button(el, "Open AWS to create the stack")).toThrow();
});

it("refuses an access key in the account field without sending anything", async () => {
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  typeInto(field(el, "AWS account ID"), "AKIAIOSFODNN7EXAMPLE");
  expect(text(el)).toContain("looks like an access key");
  expect(button(el, "Connect AWS").disabled).toBe(true);
  expect(mutation).not.toHaveBeenCalled();
});

it("sends the user to two-factor confirmation when the server asks for it", async () => {
  mutation.mockRejectedValueOnce(new ApiError("Confirm with MFA.", 403, "Open /account/mfa/challenge, verify your authenticator, then review and submit the action again."));
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  typeInto(field(el, "AWS account ID"), "123456789012");
  click(button(el, "Connect AWS"));
  await flush();
  const link = [...el.querySelectorAll("a")].find((a) => text(a) === "Confirm with two-factor");
  expect(link?.getAttribute("href")).toBe("/account/mfa/challenge?next=%2Fplatform%2Fconnections%2Faws");
});

it("only an admin can connect", () => {
  const el = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="editor" />);
  typeInto(field(el, "AWS account ID"), "123456789012");
  expect(button(el, "Connect AWS").disabled).toBe(true);
  expect(text(el)).toContain("Only a workspace admin");
});

it("manual setup: saves the submitted suffix and requires saving changed suffixes before verification", async () => {
  mutation.mockResolvedValue({ result: { ok: true, data: { connectionId: "conn-test", subject: "zenith:ws:ws-test:conn:conn-test", issuerHost: "example.com/api/oidc" } } });
  const root = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />);
  const el = manual(root);
  typeInto(field(el, "AWS account ID"), "123456789012");
  typeInto(field(el, "Region"), "us-east-1");
  typeInto(field(el, "Observe role ARN"), "arn:aws:iam::123456789012:role/ZenithObserve-team-a");
  typeInto(field(el, "Deploy role ARN"), "arn:aws:iam::123456789012:role/ZenithDeploy-team-a");
  typeInto(field(el, "Bootstrap name suffix"), "-team-a");
  click(button(el, "Save connection identifiers"));
  await flush();
  expect(mutation).toHaveBeenCalledWith("ws-test", "/platform/connections/aws/action", expect.objectContaining({ input: expect.objectContaining({ bootstrapNameSuffix: "-team-a" }) }));
  expect(button(el, "Verify connection").disabled).toBe(false);
  typeInto(field(el, "Bootstrap name suffix"), "-team-b");
  expect(button(el, "Verify connection").disabled).toBe(true);
  expect(button(el, "Save new connection identifiers").disabled).toBe(false);
  const row = [...el.querySelectorAll("tbody tr")].find((item) => text(item).startsWith("NameSuffix"))!;
  expect(text(row)).toContain("-team-a");
  expect(text(row)).not.toContain("-team-b");
  click(button(el, "Save new connection identifiers"));
  await flush();
  expect(mutation).toHaveBeenLastCalledWith("ws-test", "/platform/connections/aws/action", expect.objectContaining({ input: expect.objectContaining({ bootstrapNameSuffix: "-team-b" }) }));
  expect(button(el, "Verify connection").disabled).toBe(false);
});

it("manual setup: sends the secret writer role only when one is entered", async () => {
  mutation.mockResolvedValue({ result: { ok: true, data: { connectionId: "conn-test", subject: "zenith:ws:ws-test:conn:conn-test", issuerHost: "example.com/api/oidc" } } });
  const el = manual(mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" />));
  typeInto(field(el, "AWS account ID"), "123456789012");
  typeInto(field(el, "Region"), "us-east-1");
  typeInto(field(el, "Observe role ARN"), "arn:aws:iam::123456789012:role/ZenithObserve");
  typeInto(field(el, "Deploy role ARN"), "arn:aws:iam::123456789012:role/ZenithDeploy");
  click(button(el, "Save connection identifiers"));
  await flush();
  expect(mutation.mock.lastCall![2].input).not.toHaveProperty("secretWriterRoleArn");
  typeInto(field(el, "Secret writer role ARN"), "arn:aws:iam::123456789012:role/ZenithSecretWriterRole");
  click(button(el, "Save new connection identifiers"));
  await flush();
  expect(mutation.mock.lastCall![2].input).toMatchObject({ secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriterRole" });
});

it("manual setup: the AssumeRole principal comes from the server, never from a typed field", async () => {
  mutation.mockResolvedValue({ result: { ok: true, data: { connectionId: "conn-test", subject: "zenith:ws:ws-test:conn:conn-test", externalId: "zenith-abc" } } });
  const root = mount(<AwsConnectionFlow workspaceId="ws-test" viewerRole="admin" launch={{ oneClickReady: false, brokerPrincipalArn: "arn:aws:iam::210987654321:role/zenith-broker" }} />);
  const el = manual(root);
  expect([...el.querySelectorAll("label")].some((l) => text(l).includes("control-plane role ARN"))).toBe(false);
  typeInto(field(el, "AWS account ID"), "123456789012");
  typeInto(field(el, "Region"), "us-east-1");
  typeInto(field(el, "Observe role ARN"), "arn:aws:iam::123456789012:role/ZenithObserve");
  typeInto(field(el, "Deploy role ARN"), "arn:aws:iam::123456789012:role/ZenithDeploy");
  click(button(el, "Save connection identifiers"));
  await flush();
  expect(mutation.mock.lastCall![2].input).toMatchObject({ mode: "aws_assume_role" });
  const row = [...el.querySelectorAll("tbody tr")].find((item) => text(item).startsWith("ZenithPrincipalArn"))!;
  expect(text(row)).toContain("arn:aws:iam::210987654321:role/zenith-broker");
});
