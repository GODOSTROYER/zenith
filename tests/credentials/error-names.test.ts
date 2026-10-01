/**
 * SEC-F10: untrusted STS error names become fixed diagnostic codes. STS is
 * mocked; these checks make no claim about live AWS or trusted callback errors.
 */
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AwsCredentialBroker } from "@/lib/credentials/aws";
import { CredentialDeniedError, type CredentialEventDraft } from "@/lib/credentials/types";
import { connection, FAKE_SECRETS, grant } from "./helpers";

const sts = mockClient(STSClient);
beforeEach(() => sts.reset());
afterAll(() => sts.restore());

async function deniedWithName(name: string) {
  const upstream = new Error("Exchange refused.");
  upstream.name = name;
  sts.on(AssumeRoleCommand).rejects(upstream);
  const events: CredentialEventDraft[] = [];
  const callback = vi.fn(async () => true);
  const broker = new AwsCredentialBroker({
    resolveConnection: async () => connection({}, { mode: "aws_assume_role", externalId: "synthetic-external-id" }),
    emit: async (event) => { events.push(event); },
  });
  const error: unknown = await broker.withSession({ grant: grant(), connectionId: "conn_1", purpose: "observe" }, callback)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialDeniedError);
  expect(error).toMatchObject({ reason: "sts_failed" });
  expect(callback).not.toHaveBeenCalled();
  expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  return { error: error as CredentialDeniedError, events };
}

describe("STS error name classification", () => {
  it.each([
    ...FAKE_SECRETS,
    "synthetic_opaque_secret",
    "short",
    "AccessDenied\nsynthetic-secret",
    "AccessDeniedException synthetic-secret",
    "A".repeat(4096),
    "",
  ])("replaces unrecognized external name #%# with a fixed fallback", async (name) => {
    const { error, events } = await deniedWithName(name);
    expect(error.message).toBe("STS refused the exchange (Error): Exchange refused.");
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ reason: "sts_failed", stsError: "Error" });
    if (name) expect(JSON.stringify({ message: error.message, events })).not.toContain(name);
    expect(error.cause).toBeUndefined();
  });

  it.each(["AccessDenied", "InvalidIdentityToken", "ExpiredTokenException", "ThrottlingException"])
    ("preserves the known diagnostic code %s", async (name) => {
      const { error, events } = await deniedWithName(name);
      expect(error.message).toBe(`STS refused the exchange (${name}): Exchange refused.`);
      expect(events[0].data).toMatchObject({ reason: "sts_failed", stsError: name });
    });
});
