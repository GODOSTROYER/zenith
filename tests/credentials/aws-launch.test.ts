/** One-click AWS connection values: derived role ARNs, generated suffixes and the quick-create link. */
import { describe, expect, it } from "vitest";
import { AWS_CONNECTION_REGIONS, isBootstrapNameSuffix } from "@/lib/aws-bootstrap-input";
import { assertAwsBootstrapLimits } from "@/lib/credentials/aws/limits";
import { parseRoleArn } from "@/lib/credentials/aws/arn";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import { derivedRoleArns, generateBootstrapNameSuffix, isS3TemplateUrl, launchParameters, quickCreateUrl, stackNameFor } from "@/lib/credentials/aws/launch";
import { id } from "@/lib/domain/hash";

const TEMPLATE = "https://zenith-templates.s3.us-east-1.amazonaws.com/aws/connection/9d9d799f.yaml";

describe("generated bootstrap suffix", () => {
  it("is a valid suffix that fits every derived IAM and S3 name in every supported region", () => {
    for (let i = 0; i < 200; i++) {
      const suffix = generateBootstrapNameSuffix();
      expect(suffix).toMatch(/^-z[0-9a-z]{8}$/);
      expect(isBootstrapNameSuffix(suffix)).toBe(true);
      for (const region of AWS_CONNECTION_REGIONS) expect(() => assertAwsBootstrapLimits({ bootstrapNameSuffix: suffix, accountId: "123456789012", region })).not.toThrow();
    }
  });
  it("does not repeat across many connections", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateBootstrapNameSuffix()));
    expect(seen.size).toBe(2000);
  });
  it("uses the injected random source", () => {
    expect(generateBootstrapNameSuffix((b) => b.fill(0))).toBe("-z00000000");
  });
});

describe("derived role ARNs", () => {
  it("match the template's fixed role names with no path, in the commercial partition", () => {
    const arns = derivedRoleArns("123456789012", "-zabc12345");
    expect(arns).toEqual({
      observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserveRole-zabc12345",
      deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployRole-zabc12345",
      secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriterRole-zabc12345",
    });
    for (const arn of Object.values(arns)) expect(parseRoleArn(arn)).toMatchObject({ partition: "aws", accountId: "123456789012" });
    expect(derivedRoleArns("123456789012", "").observeRoleArn).toBe("arn:aws:iam::123456789012:role/ZenithObserveRole");
  });
  it("refuses a malformed account or suffix", () => {
    expect(() => derivedRoleArns("12345", "")).toThrow();
    expect(() => derivedRoleArns("123456789012", "team")).toThrow();
  });
  it("names the stack after the suffix", () => {
    expect(stackNameFor("-zabc12345")).toBe("zenith-connection-zabc12345");
  });
});

describe("template URL", () => {
  it.each([
    TEMPLATE,
    "https://s3.eu-west-1.amazonaws.com/zenith-templates/aws/connection.yaml",
    "https://zenith-templates.s3.amazonaws.com/aws/connection.yaml",
    "https://s3-ap-south-1.amazonaws.com/zenith-templates/aws/connection.yaml",
  ])("accepts the documented S3 format %s", (url) => expect(isS3TemplateUrl(url)).toBe(true));
  it.each([
    "http://zenith-templates.s3.us-east-1.amazonaws.com/a.yaml",
    "https://raw.githubusercontent.com/GODOSTROYER/zenith/master/deploy/aws/zenith-connection.cfn.yaml",
    `${TEMPLATE}?X-Amz-Signature=abc`,
    `${TEMPLATE}#frag`,
    "https://user:pass@zenith-templates.s3.us-east-1.amazonaws.com/a.yaml",
    "https://zenith-templates.s3.us-east-1.amazonaws.com.evil.example/a.yaml",
    "",
  ])("rejects %s", (url) => expect(isS3TemplateUrl(url)).toBe(false));
});

describe("launch parameters", () => {
  it("fill the OIDC trust for the exact subject", () => {
    expect(launchParameters({ mode: "oidc_web_identity", issuerHost: "tryzenith.cloud/api/oidc", subject: "zenith:ws:ws_1:conn:c1" }, "-zabc12345")).toEqual({
      ZenithIssuerHost: "tryzenith.cloud/api/oidc", ZenithOidcSubject: "zenith:ws:ws_1:conn:c1", CreateOidcProvider: "yes", NameSuffix: "-zabc12345",
    });
  });
  it("fill the AssumeRole trust with the server's principal and the generated ExternalId", () => {
    expect(launchParameters({ mode: "aws_assume_role", principalArn: "arn:aws:iam::210987654321:role/zenith-broker", externalId: "zenith-abc" }, "-zabc12345")).toEqual({
      ZenithPrincipalArn: "arn:aws:iam::210987654321:role/zenith-broker", ExternalId: "zenith-abc", CreateOidcProvider: "no", NameSuffix: "-zabc12345",
    });
  });
});

describe("quick-create link", () => {
  const params = launchParameters({ mode: "oidc_web_identity", issuerHost: "tryzenith.cloud/api/oidc", subject: "zenith:ws:ws_1:conn:c1" }, "-zabc12345");
  it("opens the region's create-stack review page with every value encoded", () => {
    const url = quickCreateUrl({ region: "ap-south-1", templateUrl: TEMPLATE, stackName: stackNameFor("-zabc12345"), parameters: params });
    expect(url.startsWith("https://ap-south-1.console.aws.amazon.com/cloudformation/home?region=ap-south-1#/stacks/create/review?")).toBe(true);
    const query = new URLSearchParams(url.split("#/stacks/create/review?")[1]);
    expect(query.get("templateURL")).toBe(TEMPLATE);
    expect(query.get("stackName")).toBe("zenith-connection-zabc12345");
    expect(query.get("param_ZenithOidcSubject")).toBe("zenith:ws:ws_1:conn:c1");
    expect(query.get("param_ZenithIssuerHost")).toBe("tryzenith.cloud/api/oidc");
    expect(query.get("param_NameSuffix")).toBe("-zabc12345");
    expect(url).not.toContain("zenith:ws:ws_1"); // encoded, not raw
  });
  it("refuses unsupported regions, non-S3 templates, bad stack names and bad parameter names", () => {
    expect(() => quickCreateUrl({ region: "us-gov-west-1", templateUrl: TEMPLATE, stackName: "zenith-connection", parameters: params })).toThrow();
    expect(() => quickCreateUrl({ region: "us-east-1", templateUrl: "https://example.com/t.yaml", stackName: "zenith-connection", parameters: params })).toThrow();
    expect(() => quickCreateUrl({ region: "us-east-1", templateUrl: TEMPLATE, stackName: "1-bad", parameters: params })).toThrow();
    expect(() => quickCreateUrl({ region: "us-east-1", templateUrl: TEMPLATE, stackName: "zenith-connection", parameters: { "Bad&Name": "x" } })).toThrow();
  });
});

describe("installation settings", () => {
  it("reads the broker principal and template URL, and refuses malformed values without echoing them", () => {
    expect(loadCredentialsConfig({ ZENITH_AWS_BROKER_PRINCIPAL_ARN: "arn:aws:iam::210987654321:role/zenith-broker", ZENITH_AWS_CONNECTION_TEMPLATE_URL: TEMPLATE })).toMatchObject({
      awsBrokerPrincipalArn: "arn:aws:iam::210987654321:role/zenith-broker", awsConnectionTemplateUrl: TEMPLATE,
    });
    for (const env of [{ ZENITH_AWS_BROKER_PRINCIPAL_ARN: "arn:aws:iam::210987654321:user/CANARY" }, { ZENITH_AWS_CONNECTION_TEMPLATE_URL: "https://example.com/CANARY.yaml" }]) {
      let message = "";
      try { loadCredentialsConfig(env); } catch (error) { message = String((error as Error).message); }
      expect(message).not.toBe("");
      expect(message).not.toContain("CANARY");
    }
  });
});

describe("ids", () => {
  it("keep their shape and draw the tail from the CSPRNG, not Math.random", () => {
    const original = Math.random;
    Math.random = () => 0.5;
    try {
      const ids = new Set(Array.from({ length: 500 }, () => id()));
      expect(ids.size).toBe(500);
      for (const value of ids) expect(value).toMatch(/^[0-9a-z]+$/);
    } finally { Math.random = original; }
  });
});
