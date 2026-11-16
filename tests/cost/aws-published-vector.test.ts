import { describe, expect, it } from "vitest";
import { signAwsV4 } from "@/lib/cost/billing/aws";

// AWS-owned suite: https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4/get-vanilla
// header-signature.txt is an independent expected value, not computed by this signer.
const credentials = () => ({ accessKeyId: ["AKID", "EXAMPLE"].join(""),
  secretAccessKey: ["wJalrXUtnFEMI", "/K7MDENG+bPxRfiCY", "EXAMPLEKEY"].join("") });
const options = { service: "service", region: "us-east-1", now: new Date("2015-08-30T12:36:00Z") };

describe("AWS published SigV4 get-vanilla vector", () => {
  it("matches AWS's published header signature exactly", () => {
    const signed = signAwsV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {} }, credentials(), options);
    expect(signed.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${credentials().accessKeyId}/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);
  });
  it("sorts repeated query values and excludes a previous authorization on resigning", () => {
    const sign = (query: string) => signAwsV4({ method: "GET", url: `https://example.amazonaws.com/?${query}`, headers: {} }, credentials(), options);
    expect(sign("key=z&key=a").headers.authorization).toBe(sign("key=a&key=z").headers.authorization);
    const first = sign("key=a");
    expect(signAwsV4(first, credentials(), options).headers.authorization).toBe(first.headers.authorization);
  });
});
