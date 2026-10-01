/**
 * Static checks on the customer bootstrap artifacts: deploy/aws/zenith-connection.cfn.yaml
 * and its OpenTofu equivalent. These parse and EVALUATE the template (Ref, Sub,
 * If, Join …) for several parameter sets and assert the security properties the
 * README promises. They do not — cannot — prove the policies work against real
 * AWS; see the README's "verified vs unverified" section.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generate, POLICIES_DIR, TEMPLATE_PATH } from "../../deploy/aws/tools/generate-tofu-policies";
import { sessionPolicyFor } from "@/lib/credentials/aws";
import {
  asList,
  compactSize,
  iamGlob,
  loadTemplate,
  makeEvaluator,
  resolveResource,
  statementsOf,
  type Evaluator,
  type Statement,
} from "./cfn";
import { ACCOUNT } from "./helpers";

const template = loadTemplate(TEMPLATE_PATH);
const MODULE_DIR = path.resolve(path.dirname(TEMPLATE_PATH), "tofu-module");

const ISSUER_HOST = "app.tryzenith.cloud/api/oidc";
const SUBJECT = "zenith:ws:ws_1:conn:conn_1";
const KMS = "arn:aws:kms:ap-south-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const ZONES = "arn:aws:route53:::hostedzone/Z0123456789ABC,arn:aws:route53:::hostedzone/Z9876543210XYZ";
const PRINCIPAL = "arn:aws:iam::210987654321:role/zenith-control";

const SCENARIOS: Record<string, Record<string, string>> = {
  oidc: { ZenithIssuerHost: ISSUER_HOST, ZenithOidcSubject: SUBJECT },
  everything: {
    ZenithIssuerHost: ISSUER_HOST,
    ZenithOidcSubject: SUBJECT,
    CreateOidcProvider: "no",
    ZenithPrincipalArn: PRINCIPAL,
    ExternalId: "zx-0123456789abcdef",
    StateBucketKmsKeyArn: KMS,
    Route53HostedZoneArns: ZONES,
    NameSuffix: "-team-a",
    EnvironmentTagValue: "env_prod1",
  },
  assumeRoleOnly: { ZenithPrincipalArn: PRINCIPAL, ExternalId: "zx-0123456789abcdef" },
};

const MANAGED = Object.entries(template.Resources)
  .filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy")
  .map(([id]) => id);
const DEPLOY_POLICIES = MANAGED.filter((id) => id.startsWith("Deploy"));

const evaluatorFor = (name: string): Evaluator => makeEvaluator(template, { params: SCENARIOS[name] });

function policyDoc(ev: Evaluator, logicalId: string): unknown {
  return resolveResource(template, ev, logicalId)!.PolicyDocument;
}

function allPolicyDocuments(ev: Evaluator): { where: string; doc: unknown }[] {
  const docs: { where: string; doc: unknown }[] = [];
  for (const [id, res] of Object.entries(template.Resources)) {
    const props = resolveResource(template, ev, id);
    if (!props) continue;
    if (res.Type === "AWS::IAM::ManagedPolicy" || res.Type === "AWS::S3::BucketPolicy") docs.push({ where: id, doc: props.PolicyDocument });
    if (res.Type === "AWS::IAM::Role") {
      docs.push({ where: `${id}.AssumeRolePolicyDocument`, doc: props.AssumeRolePolicyDocument });
      for (const p of (props.Policies as { PolicyName: string; PolicyDocument: unknown }[] | undefined) ?? []) {
        docs.push({ where: `${id}.Policies.${p.PolicyName}`, doc: p.PolicyDocument });
      }
    }
  }
  return docs;
}

const READ_VERB = /^[a-z0-9-]+:(Describe|List|Get|BatchGet|Lookup|Search|Check|Head|View|Query|Scan|Filter|StartQuery|StopQuery|Decrypt|GenerateDataKey|Batch(Check|Get))/i;

const allows = (statements: Statement[]) => statements.filter((s) => s.Effect === "Allow");

describe("template structure", () => {
  it("parses with CloudFormation tags and declares the resources the README documents", () => {
    const types = Object.fromEntries(Object.entries(template.Resources).map(([id, r]) => [id, r.Type]));
    expect(types).toMatchObject({
      OidcProvider: "AWS::IAM::OIDCProvider",
      StateBucket: "AWS::S3::Bucket",
      StateBucketPolicy: "AWS::S3::BucketPolicy",
      WorkloadBoundary: "AWS::IAM::ManagedPolicy",
      ObserveRole: "AWS::IAM::Role",
      DeployRole: "AWS::IAM::Role",
      CodeBuildRole: "AWS::IAM::Role",
    });
    expect(Object.keys(template.Outputs)).toEqual(
      expect.arrayContaining(["ObserveRoleArn", "DeployRoleArn", "StateBucketName", "CodeBuildRoleArn", "WorkloadBoundaryArn", "AccountId"])
    );
    expect(Object.keys(template.Parameters)).toEqual(
      expect.arrayContaining(["ZenithIssuerHost", "ZenithOidcSubject", "CreateOidcProvider", "ExternalId", "ZenithPrincipalArn", "EnvironmentTagValue"])
    );
  });

  it("creates the OIDC provider for sts.amazonaws.com against the issuer (and only when asked)", () => {
    const on = resolveResource(template, evaluatorFor("oidc"), "OidcProvider")!;
    expect(on.Url).toBe(`https://${ISSUER_HOST}`);
    expect(on.ClientIdList).toEqual(["sts.amazonaws.com"]);
    expect(resolveResource(template, evaluatorFor("everything"), "OidcProvider")).toBeUndefined();
    expect(resolveResource(template, evaluatorFor("assumeRoleOnly"), "OidcProvider")).toBeUndefined();
  });

  it("validates parameters: exact subject only, no wildcards, no scheme, sane suffix", () => {
    const ok = (name: string, value: string) => new RegExp(template.Parameters[name].AllowedPattern!).test(value);
    expect(ok("ZenithOidcSubject", SUBJECT)).toBe(true);
    for (const bad of ["zenith:ws:*:conn:*", "zenith:ws:ws_1:conn:*", "zenith:ws:a:conn:b:c", "zenith:ws:ws_1", "repo:evil/x:*", "zenith:ws:ws 1:conn:c"]) {
      expect(ok("ZenithOidcSubject", bad)).toBe(false);
    }
    expect(ok("ZenithIssuerHost", ISSUER_HOST)).toBe(true);
    for (const bad of [`https://${ISSUER_HOST}`, "App.Example.com", "app.example.com/api oidc", "-bad.example.com"]) {
      expect(ok("ZenithIssuerHost", bad)).toBe(false);
    }
    expect(ok("NameSuffix", "-team-a")).toBe(true);
    expect(ok("NameSuffix", "team-a")).toBe(false);
    expect(ok("ExternalId", "x")).toBe(false);
    expect(ok("ExternalId", "zx-0123456789abcdef")).toBe(true);
    expect(ok("ZenithPrincipalArn", PRINCIPAL)).toBe(true);
    expect(ok("ZenithPrincipalArn", "*")).toBe(false);
  });
});

describe.each(Object.keys(SCENARIOS))("IAM policies (%s)", (scenario) => {
  const ev = evaluatorFor(scenario);
  const docs = allPolicyDocuments(ev);
  it("SNS/EBS/EKS mutations require creation or resource tags and account/environment ARN scopes", () => {
    const statement = (policy: string, sid: string) => statementsOf(policyDoc(ev, policy)).find((s) => s.Sid === sid)!;
    for (const [policy, sid, tag] of [
      ["DeployDataPolicy", "SnsCreateTaggedTopics", "RequestTag"], ["DeployDataPolicy", "SnsManageTaggedTopics", "ResourceTag"],
      ["DeployNetworkPolicy", "EbsCreateTaggedVolumes", "RequestTag"], ["DeployNetworkPolicy", "EbsManageTaggedVolumesAndInstances", "ResourceTag"],
      ["DeployComputePolicy", "EksCreateTaggedCluster", "RequestTag"], ["DeployComputePolicy", "EksCreateTaggedChildren", "RequestTag"],
      ["DeployComputePolicy", "EksManageTaggedResources", "ResourceTag"],
    ]) {
      const s = statement(policy, sid);
      expect(s.Condition?.StringEquals?.[`aws:${tag}/zenith:managed`], sid).toBe("true");
      expect(s.Condition?.StringLike?.[`aws:${tag}/zenith:environment`], sid).toBe(scenario === "everything" ? "env_prod1" : "*");
      if (sid !== "EksCreateTaggedCluster") expect(asList(s.Resource).every((arn) => arn.includes(ACCOUNT) && arn !== "*"), sid).toBe(true);
    }
    const attach = statement("DeployNetworkPolicy", "EbsManageTaggedVolumesAndInstances");
    expect(asList(attach.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:volume/*`, `arn:aws:ec2:*:${ACCOUNT}:instance/*`]);
    expect(statement("DeployComputePolicy", "EksCreateTaggedCluster").Condition?.Bool).toEqual({ "eks:bootstrapClusterCreatorAdminPermissions": "false" });
    expect(statement("DeployEdgePolicy", "KmsGrantToAwsResources").Condition?.Bool).toEqual({ "kms:GrantIsForAWSResource": "true" });
    expect(asList(statement("DeployNetworkPolicy", "Ec2TagOnCreate").Condition?.StringEquals?.["ec2:CreateAction"] as string[])).toContain("CreateVolume");
  });

  it("permits native CNI ENIs without Zenith tags while protecting node and resource tags", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const eni = statements.find((s) => s.Sid === "WorkloadEksNetworkInterfaces")!;
    expect(asList(eni.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:network-interface/*`]);
    expect(eni.Condition).toBeUndefined();
    const node = statements.find((s) => s.Sid === "WorkloadEksTaggedNodes")!;
    expect(asList(node.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:instance/*`]);
    expect(node.Condition?.StringEquals?.["aws:ResourceTag/zenith:managed"]).toBe("true");
    expect(node.Condition?.StringLike?.["aws:ResourceTag/zenith:environment"]).toBe(scenario === "everything" ? "env_prod1" : "*");
    const tagging = statements.find((s) => s.Sid === "WorkloadEksCniTags")!;
    expect(asList(tagging.Resource)).toEqual([`arn:aws:ec2:*:${ACCOUNT}:network-interface/*`]);
    expect(asList(tagging.Condition?.["ForAllValues:StringEquals"]?.["aws:TagKeys"] as string[])).toEqual([
      "node.k8s.amazonaws.com/instance_id", "node.k8s.amazonaws.com/createdAt", "cluster.k8s.amazonaws.com/name", "eks:eni:owner",
    ]);
  });

  it("never allows Action * or service:* — and never Action * on Resource *", () => {
    for (const { where, doc } of docs) {
      for (const s of allows(statementsOf(doc))) {
        for (const a of asList(s.Action)) {
          expect(a, `${where}/${s.Sid}`).not.toMatch(/^\*$|:\*$/);
        }
        const wild = asList(s.Action).includes("*") && asList(s.Resource).includes("*");
        expect(wild, `${where}/${s.Sid} allows * on *`).toBe(false);
        expect(s.NotAction, `${where}/${s.Sid}`).toBeUndefined();
      }
    }
  });

  it("has unique Sids, no Principal in identity policies, and stays within IAM size limits", () => {
    for (const { where, doc } of docs) {
      const statements = statementsOf(doc);
      const sids = statements.map((s) => s.Sid).filter(Boolean);
      expect(new Set(sids).size, `${where} duplicate Sid`).toBe(sids.length);
      if (!where.includes("AssumeRolePolicyDocument") && !where.startsWith("StateBucketPolicy")) {
        for (const s of statements) expect(s.Principal, `${where}/${s.Sid}`).toBeUndefined();
      }
      if (MANAGED.includes(where)) expect(compactSize(doc), `${where} (managed policy limit 6,144)`).toBeLessThanOrEqual(6144);
      if (where.includes("AssumeRolePolicyDocument")) {
        expect(JSON.stringify(typeof doc === "string" ? JSON.parse(doc) : doc).length, `${where} trust policy (2,048)`).toBeLessThanOrEqual(2048);
      }
    }
    for (const role of ["ObserveRole", "DeployRole", "CodeBuildRole"]) {
      const props = resolveResource(template, ev, role)!;
      const inline = ((props.Policies as { PolicyDocument: unknown }[] | undefined) ?? []).reduce((n, p) => n + compactSize(p.PolicyDocument), 0);
      expect(inline, `${role} inline policies (10,240)`).toBeLessThanOrEqual(10240);
      expect(asList(props.ManagedPolicyArns as string[] | undefined).length, `${role} managed policies`).toBeLessThanOrEqual(8);
    }
  });

  it("observe policy is read-only and can never read secret values", () => {
    const statements = statementsOf(policyDoc(ev, "ObservePolicy"));
    for (const s of allows(statements)) {
      for (const a of asList(s.Action)) expect(a, `${s.Sid}`).toMatch(READ_VERB);
    }
    const deny = statements.find((s) => s.Sid === "NeverReadSecretValues")!;
    expect(deny.Effect).toBe("Deny");
    expect(asList(deny.Action)).toEqual(expect.arrayContaining(["secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]));
    // secretsmanager: describe/list only
    const secrets = allows(statements).flatMap((s) => asList(s.Action)).filter((a) => a.startsWith("secretsmanager:"));
    expect(secrets.sort()).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:ListSecrets"]);
  });

  it("every mutating deploy-role permission is tag- or name-conditioned (documented exceptions only)", () => {
    // AWS offers no resource-level control for these; each is called out in the template header.
    const EXCEPTIONS: Record<string, string> = {
      EcsTaskDefinitionRevisions: "ecs:RegisterTaskDefinition/DeregisterTaskDefinition only support Resource *",
      Ec2RunInstancesFromImages: "AMIs and snapshots are not ours; RunInstances is still denied without tagged instance/volume/ENI",
    };
    const seen = new Set<string>();
    for (const id of DEPLOY_POLICIES) {
      for (const s of allows(statementsOf(policyDoc(ev, id)))) {
        const mutating = asList(s.Action).filter((a) => !READ_VERB.test(a));
        if (mutating.length === 0) continue;
        if (s.Sid! in EXCEPTIONS) {
          seen.add(s.Sid!);
          continue;
        }
        const condKeys = Object.values(s.Condition ?? {}).flatMap((c) => Object.keys(c));
        const tagged = condKeys.some((k) => /^aws:(Request|Resource)Tag\/zenith:managed$/.test(k));
        const iamGuard = condKeys.some((k) => ["iam:PermissionsBoundary", "iam:PassedToService", "iam:AWSServiceName"].includes(k));
        const resources = asList(s.Resource);
        const scoped = resources.length > 0 && resources.every((r) => r !== "*" && (r.includes("zenith") || !r.includes("*")));
        expect(tagged || iamGuard || scoped, `${id}/${s.Sid} mutates ${mutating.join(", ")} without a tag or name condition`).toBe(true);
      }
    }
    // the exceptions list itself must not go stale
    expect([...seen].sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  });

  it("the deploy role can never read or write secret values, mint credentials or touch the OIDC provider", () => {
    const actions = DEPLOY_POLICIES.flatMap((id) => allows(statementsOf(policyDoc(ev, id)))).flatMap((s) => asList(s.Action));
    for (const forbidden of [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "ssm:GetParameter",
      "ssm:PutParameter",
      "iam:CreateAccessKey",
      "iam:CreateUser",
      "iam:CreateLoginProfile",
      "iam:CreateOpenIDConnectProvider",
      "sts:AssumeRole",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
    ]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  it("IAM: roles are created/changed only with the permission boundary, PassRole is service-limited, self-modification is denied", () => {
    const statements = statementsOf(policyDoc(ev, "DeployIamPolicy"));
    const boundary = evaluatorForRef(ev, "WorkloadBoundary");
    const byActionAllowed = (action: string) => allows(statements).filter((s) => asList(s.Action).includes(action));

    for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"]) {
      const found = byActionAllowed(action);
      expect(found.length, action).toBe(1);
      expect(found[0].Condition?.StringEquals?.["iam:PermissionsBoundary"], action).toBe(boundary);
      expect(asList(found[0].Resource), action).toEqual([`arn:aws:iam::${ACCOUNT}:role/zenith-*`]);
    }
    const attach = byActionAllowed("iam:AttachRolePolicy")[0];
    expect(asList(attach.Condition?.ArnLike?.["iam:PolicyARN"] as string[]).every((a) => /policy\/zenith-\*$|policy\/(AmazonEKSClusterPolicy|AmazonEKSWorkerNodePolicy|AmazonEKS_CNI_Policy|AmazonEC2ContainerRegistryReadOnly)$|policy\/service-role\/(AmazonECSTaskExecutionRolePolicy|AWSLambda(Basic|VPCAccess)ExecutionRole)$/.test(a))).toBe(true);

    const pass = byActionAllowed("iam:PassRole")[0];
    expect(pass.Condition?.StringEquals?.["iam:PassedToService"]).toEqual(["ecs-tasks.amazonaws.com", "codebuild.amazonaws.com", "lambda.amazonaws.com", "eks.amazonaws.com", "ec2.amazonaws.com"]);
    expect(asList(pass.Resource)).toEqual([`arn:aws:iam::${ACCOUNT}:role/zenith-*`]);

    const self = statements.find((s) => s.Sid === "DenyModifyingZenithBootstrapRolesAndPolicies")!;
    expect(self.Effect).toBe("Deny");
    const resources = asList(self.Resource).join(" ");
    for (const p of ["role/ZenithDeploy*", "role/ZenithObserve*", "role/zenith-codebuild*", "policy/ZenithDeploy*", "policy/ZenithObserve*", "policy/ZenithWorkloadBoundary*"]) {
      expect(resources).toContain(p);
    }
    expect(asList(self.Action)).toEqual(expect.arrayContaining(["iam:AttachRolePolicy", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion"]));

    const boundaryGuard = statements.find((s) => s.Sid === "DenyRemovingAnyPermissionsBoundary")!;
    expect(asList(boundaryGuard.Action)).toEqual(["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"]);
    expect(boundaryGuard.Resource).toBe("*");

    const oidc = statements.find((s) => s.Sid === "DenyOidcProviderAndPrincipalCreation")!;
    expect(asList(oidc.Action)).toEqual(expect.arrayContaining(["iam:DeleteOpenIDConnectProvider", "iam:CreateUser", "iam:CreateAccessKey", "organizations:*"]));
  });

  it("permission boundary allows workload access only and denies IAM, organizations and the state bucket", () => {
    const statements = statementsOf(policyDoc(ev, "WorkloadBoundary"));
    const denied = statements.filter((s) => s.Effect === "Deny");
    expect(denied.flatMap((s) => asList(s.Action))).toEqual(expect.arrayContaining(["iam:*", "organizations:*", "account:*", "s3:*"]));
    const stateDeny = denied.find((s) => s.Sid === "DenyStateBucket")!;
    expect(asList(stateDeny.Resource).some((r) => r.includes("zenith-state-"))).toBe(true);
    const actions = allows(statements).flatMap((s) => asList(s.Action));
    expect(actions.filter((a) => a.startsWith("iam:") || a.startsWith("sts:") || a.startsWith("organizations:"))).toEqual([]);
    // secret reads exist only for the workload's own secrets, by ARN prefix
    const secretStmt = allows(statements).find((s) => s.Sid === "WorkloadReadItsOwnSecrets")!;
    expect(asList(secretStmt.Resource).every((r) => r.includes("zenith/"))).toBe(true);
  });

  it("state bucket policy denies plain HTTP and TLS < 1.2; deploy role cannot administer or shorten its history", () => {
    const bucket = statementsOf(policyDoc(ev, "StateBucketPolicy"));
    expect(bucket.find((s) => s.Sid === "DenyInsecureTransport")).toMatchObject({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } });
    expect(bucket.find((s) => s.Sid === "DenyTlsBelow12")).toMatchObject({ Effect: "Deny", Condition: { NumericLessThan: { "s3:TlsVersion": "1.2" } } });
    const state = statementsOf(policyDoc(ev, "DeployStatePolicy"));
    const admin = state.find((s) => s.Sid === "DenyStateBucketAdministration")!;
    expect(asList(admin.Action)).toEqual(expect.arrayContaining(["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock"]));
    expect(state.find((s) => s.Sid === "DenyStateHistoryDeletion")).toMatchObject({ Effect: "Deny", Action: "s3:DeleteObjectVersion" });
    // the state bucket is not something the deploy role may reconfigure through the zenith-* bucket statement... which is why the explicit deny exists
    const data = statementsOf(policyDoc(ev, "DeployDataPolicy"));
    const buckets = data.find((s) => s.Sid === "S3ManageZenithBuckets")!;
    expect(buckets.Resource).toBe("arn:aws:s3:::zenith-*");
  });

  it("CodeBuild role: assumable only by CodeBuild in this account; pushes only to zenith-* repositories; reads only the artifact prefix", () => {
    const props = resolveResource(template, ev, "CodeBuildRole")!;
    const trust = statementsOf(props.AssumeRolePolicyDocument);
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({ Principal: { Service: "codebuild.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } });
    const statements = statementsOf((props.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument);
    const push = statements.find((s) => s.Sid === "PushImagesToZenithRepositories")!;
    expect(push.Resource).toBe(`arn:aws:ecr:*:${ACCOUNT}:repository/zenith-*`);
    const reads = statements.find((s) => s.Sid === "ReadBuildArtifacts")!;
    expect(asList(reads.Resource).every((r) => r.endsWith("/artifacts/*"))).toBe(true);
    expect(asList(reads.Action).every((a) => a.startsWith("s3:Get"))).toBe(true);
    expect(allows(statements).flatMap((s) => asList(s.Action)).filter((a) => a.startsWith("iam:") || a.startsWith("secretsmanager:"))).toEqual([]);
  });
});

/** The ARN `Ref` yields for a resource under the scenario's parameters. */
function evaluatorForRef(ev: Evaluator, logicalId: string): string {
  return ev.resourceRef(logicalId);
}

describe("trust policies", () => {
  for (const role of ["ObserveRole", "DeployRole"]) {
    it(`${role}: OIDC statements pin issuer, audience and the exact subject; nothing else can assume it`, () => {
      const trust = statementsOf(resolveResource(template, evaluatorFor("oidc"), role)!.AssumeRolePolicyDocument);
      const pinned = { StringEquals: { [`${ISSUER_HOST}:aud`]: "sts.amazonaws.com", [`${ISSUER_HOST}:sub`]: SUBJECT } };
      const principal = { Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER_HOST}` };
      expect(trust).toEqual([
        {
          Sid: "ZenithOidc",
          Effect: "Allow",
          Principal: principal,
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { ...pinned, StringLike: { "sts:RoleSessionName": "zenith-*" } },
        },
        // session tags travel in the token, so the trust policy must also allow TagSession (same pins)
        { Sid: "ZenithOidcTagSession", Effect: "Allow", Principal: principal, Action: "sts:TagSession", Condition: pinned },
      ]);
      expect(JSON.stringify(trust)).not.toMatch(/"StringLike":\{"[^"]*:sub"/);
    });

    it(`${role}: AssumeRole path requires the ExternalId and the principal; TagSession is a separate statement`, () => {
      const trust = statementsOf(resolveResource(template, evaluatorFor("everything"), role)!.AssumeRolePolicyDocument);
      expect(trust.map((s) => s.Sid)).toEqual(["ZenithOidc", "ZenithOidcTagSession", "ZenithAssumeRole", "ZenithTagSession"]);
      expect(trust[2]).toMatchObject({
        Principal: { AWS: PRINCIPAL },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": "zx-0123456789abcdef" } },
      });
      expect(trust[3]).toEqual({ Sid: "ZenithTagSession", Effect: "Allow", Principal: { AWS: PRINCIPAL }, Action: "sts:TagSession" });
      const only = statementsOf(resolveResource(template, evaluatorFor("assumeRoleOnly"), role)!.AssumeRolePolicyDocument);
      expect(only.map((s) => s.Sid)).toEqual(["ZenithAssumeRole", "ZenithTagSession"]);
    });
  }
});

describe("state bucket", () => {
  it("is versioned, private, encrypted (AES256 or the given KMS key), TLS-only and survives stack deletion", () => {
    expect(template.Resources.StateBucket.DeletionPolicy).toBe("Retain");
    expect(template.Resources.StateBucket.UpdateReplacePolicy).toBe("Retain");
    const plain = resolveResource(template, evaluatorFor("oidc"), "StateBucket")!;
    expect(plain.BucketName).toBe(`zenith-state-${ACCOUNT}-ap-south-1`);
    expect(plain.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(plain.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(plain.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
    expect(plain.BucketEncryption).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
    const kms = resolveResource(template, evaluatorFor("everything"), "StateBucket")!;
    expect(kms.BucketName).toBe(`zenith-state-${ACCOUNT}-ap-south-1-team-a`);
    expect(kms.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: KMS } }],
    });
    // the bootstrap tag is NOT the managed tag: the deploy role must not be able to see it as its own
    for (const r of ["StateBucket", "ObserveRole", "DeployRole", "CodeBuildRole"]) {
      const tags = resolveResource(template, evaluatorFor("oidc"), r)!.Tags as { Key: string }[];
      expect(tags.map((t) => t.Key)).toEqual(["zenith:bootstrap"]);
    }
  });
});

describe("optional features change only what they should", () => {
  it("route53 write access exists only for listed zones; KMS statements only with a key", () => {
    const data = (s: string) => statementsOf(policyDoc(evaluatorFor(s), "DeployEdgePolicy"));
    expect(data("oidc").some((s) => s.Sid === "Route53ChangeRecordsInListedZones")).toBe(false);
    const dns = data("everything").find((s) => s.Sid === "Route53ChangeRecordsInListedZones")!;
    expect(dns.Resource).toEqual(ZONES.split(","));
    expect(dns.Action).toBe("route53:ChangeResourceRecordSets");
    for (const [id, sid] of [["ObservePolicy", "ReadStateKmsKey"], ["DeployStatePolicy", "StateKmsKey"]] as const) {
      expect(statementsOf(policyDoc(evaluatorFor("oidc"), id)).some((s) => s.Sid === sid)).toBe(false);
      const on = statementsOf(policyDoc(evaluatorFor("everything"), id)).find((s) => s.Sid === sid)!;
      expect(on.Resource).toBe(KMS);
    }
  });

  it("the environment scope reaches every tag condition on the deploy role", () => {
    const network = JSON.stringify(policyDoc(evaluatorFor("everything"), "DeployNetworkPolicy"));
    expect(network).toContain('"aws:RequestTag/zenith:environment":"env_prod1"');
    expect(network).toContain('"aws:ResourceTag/zenith:environment":"env_prod1"');
    expect(JSON.stringify(policyDoc(evaluatorFor("oidc"), "DeployNetworkPolicy"))).toContain('"aws:ResourceTag/zenith:environment":"*"');
  });
});

describe("the broker's session policies stay inside the roles they narrow", () => {
  const ev = evaluatorFor("oidc");
  const grants = (ids: string[]) =>
    ids.flatMap((id) => allows(statementsOf(policyDoc(ev, id)))).map((s) => ({ actions: asList(s.Action), resources: asList(s.Resource) }));
  const observe = grants(["ObservePolicy"]);
  const deploy = grants(["ObservePolicy", ...DEPLOY_POLICIES]);
  const ctx = { accountId: ACCOUNT, region: "ap-south-1", environmentId: "env_1" };

  const isGranted = (granted: ReturnType<typeof grants>, action: string, resource: string) =>
    granted.some((g) => g.actions.some((ga) => iamGlob(ga.toLowerCase(), action.toLowerCase())) && g.resources.some((gr) => iamGlob(gr, resource)));

  it.each([
    ["infrastructure.observe", observe],
    ["topology.read", observe],
    ["firewall.inspect", observe],
    ["metrics.read", observe],
    ["logs.read", observe],
    ["service.restart", deploy],
    ["service.scale", deploy],
    ["database.snapshot", deploy],
  ] as const)("%s only asks for permissions its role grants (by action and resource pattern)", (cap, granted) => {
    const policy = sessionPolicyFor(cap, ctx)!;
    for (const stmt of policy.Statement as Statement[]) {
      const missing = asList(stmt.Action).flatMap((a) =>
        asList(stmt.Resource)
          .filter((r) => !isGranted(granted, a, r))
          .map((r) => `${a} on ${r}`)
      );
      expect(missing, `${cap} asks for permissions its role does not grant`).toEqual([]);
    }
  });
});

describe("OpenTofu module", () => {
  const strip = (s: string) => s.replace(/\r\n/g, "\n");

  it("policy templates are exactly what the generator derives from the CloudFormation template", () => {
    const generated = generate();
    const onDisk = fs.readdirSync(POLICIES_DIR).sort();
    expect(onDisk).toEqual(Object.keys(generated).sort());
    for (const [name, text] of Object.entries(generated)) {
      expect(strip(fs.readFileSync(path.join(POLICIES_DIR, name), "utf8")), `${name} is stale; run npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`).toBe(text);
    }
  });

  it("rendered templates equal the evaluated CloudFormation policies (default scenario)", () => {
    const ev = evaluatorFor("oidc");
    const vars: Record<string, string> = {
      partition: "aws",
      account_id: ACCOUNT,
      region: "ap-south-1",
      state_bucket: `zenith-state-${ACCOUNT}-ap-south-1`,
      state_bucket_arn: `arn:aws:s3:::zenith-state-${ACCOUNT}-ap-south-1`,
      boundary_arn: ev.resourceRef("WorkloadBoundary"),
      environment_tag_value: "*",
    };
    const render = (file: string) => JSON.parse(strip(fs.readFileSync(path.join(POLICIES_DIR, file), "utf8")).replace(/\$\{(\w+)\}/g, (_m, k: string) => vars[k]));
    const files: Record<string, string> = {
      ObservePolicy: "observe.json.tftpl",
      DeployNetworkPolicy: "deploy-network.json.tftpl",
      DeployComputePolicy: "deploy-compute.json.tftpl",
      DeployDataPolicy: "deploy-data.json.tftpl",
      DeployStatePolicy: "deploy-state.json.tftpl",
      DeployIamPolicy: "deploy-iam.json.tftpl",
      WorkloadBoundary: "workload-boundary.json.tftpl",
    };
    for (const [id, file] of Object.entries(files)) {
      expect(render(file), id).toEqual(JSON.parse(JSON.stringify(policyDoc(ev, id))));
    }
    const cb = (resolveResource(template, ev, "CodeBuildRole")!.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument;
    expect(render("codebuild.json.tftpl")).toEqual(JSON.parse(JSON.stringify(cb)));
  });

  it("main.tf pins the same trust conditions and bucket protections as the template", () => {
    const main = fs.readFileSync(path.join(MODULE_DIR, "main.tf"), "utf8");
    for (const needle of [
      '"${var.zenith_issuer_host}:aud" = "sts.amazonaws.com"',
      '"${var.zenith_issuer_host}:sub" = var.zenith_oidc_subject',
      '"sts:RoleSessionName" = "zenith-*"',
      '"sts:ExternalId" = var.external_id',
      'client_id_list = ["sts.amazonaws.com"]',
      'status = "Enabled"',
      "block_public_acls       = true",
      "restrict_public_buckets = true",
      '"aws:SecureTransport" = "false"',
      '"s3:TlsVersion" = "1.2"',
      "force_destroy = false",
      "max_session_duration = 3600",
    ]) {
      expect(main, needle).toContain(needle);
    }
    expect(main).not.toMatch(/"zenith:managed"s*=/);
  });

  const tofuAvailable = spawnSync("tofu", ["version"], { encoding: "utf8" }).status === 0;
  // Needs the AWS provider from registry.opentofu.org (~60 s the first time).
  it.skipIf(!process.env.ZENITH_TEST_TOFU || !tofuAvailable)("tofu init + validate + test (mock provider, offline after init)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-tofu-"));
    fs.cpSync(MODULE_DIR, dir, { recursive: true });
    const run = (...args: string[]) => execFileSync("tofu", args, { cwd: dir, encoding: "utf8", timeout: 240_000 });
    run("init", "-backend=false", "-input=false");
    expect(run("validate")).toContain("valid");
    expect(run("test")).toMatch(/Success!/);
  }, 300_000);
});
