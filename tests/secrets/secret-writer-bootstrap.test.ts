/** Static template/policy contract. Does not assume/deploy any AWS role. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplate, makeEvaluator, resolveResource, statementsOf, asList, iamGlob } from "../credentials/cfn";
import { generate, TEMPLATE_PATH, POLICIES_DIR } from "../../deploy/aws/tools/generate-tofu-policies";

describe("AWS secret writer bootstrap", () => {
  const template = loadTemplate(TEMPLATE_PATH);
  const ev = makeEvaluator(template, { params: { ZenithIssuerHost: "zenith.test/api/oidc", ZenithOidcSubject: "zenith:ws:ws1:conn:conn1", EnvironmentTagValue: "env1" } });
  const writer = resolveResource(template, ev, "SecretWriterRole")!;
  const document = (writer.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument;
  it("has separate trust and only environment-scoped secret write/metadata permissions", () => {
    expect(writer.RoleName).toBe("ZenithSecretWriterRole");
    const statements = statementsOf(document);
    expect(statements).toHaveLength(1);
    expect(asList(statements[0].Action)).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"]);
    expect(statements[0].Condition).toMatchObject({ StringEquals: { "aws:ResourceTag/zenith:managed": "true", "aws:PrincipalTag/zenith:capability": "secret.write" }, StringLike: { "aws:ResourceTag/zenith:environment": "env1" } });
    const resources = asList(statements[0].Resource);
    expect(resources.some((r) => iamGlob(r, "arn:aws:secretsmanager:us-east-1:123456789012:secret:zenith/zenith-env1-key-abcdef"))).toBe(true);
    expect(resources.some((r) => iamGlob(r, "arn:aws:secretsmanager:us-east-1:123456789012:secret:zenith/zenith-env2-key-abcdef"))).toBe(false);
    expect(writer.ManagedPolicyArns).toBeUndefined();
    expect(writer.AssumeRolePolicyDocument).toEqual(resolveResource(template, ev, "DeployRole")!.AssumeRolePolicyDocument);
  });
  it("does not attach the writer policy to deploy and exports the writer role", () => {
    const deploy = resolveResource(template, ev, "DeployRole")!;
    expect(JSON.stringify(deploy)).not.toContain("SecretWriter");
    expect(template.Outputs.SecretWriterRoleArn).toBeDefined();
    const moduleText = fs.readFileSync(path.resolve(path.dirname(TEMPLATE_PATH), "tofu-module/main.tf"), "utf8");
    expect(moduleText).toContain('role   = aws_iam_role.secret_writer.id');
    expect(moduleText).toContain('policies/secret-writer.json.tftpl');
  });
  it("keeps generated writer policy identical to the template", () => {
    expect(fs.readFileSync(path.join(POLICIES_DIR, "secret-writer.json.tftpl"), "utf8").replace(/\r\n/g, "\n")).toBe(generate()["secret-writer.json.tftpl"]);
  });
});
