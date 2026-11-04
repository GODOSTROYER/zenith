/** Disposable LocalStack setup only. No ambient credentials, non-loopback endpoints or live AWS path. */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { IAMClient, CreateRoleCommand } from "@aws-sdk/client-iam";
import { LambdaClient, CreateFunctionCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";
const [dir, output] = process.argv.slice(2);
if (process.env.ZENITH_TEST_MIXED_LAMBDA !== "1" || !dir || !output) throw new Error("Requires ZENITH_TEST_MIXED_LAMBDA=1; usage: localstack-lambda.mjs PACKAGE_DIR BINDING_JSON");
const endpoint = process.env.ENRICHER_LAMBDA_ENDPOINT;
const url = new URL(endpoint);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Owned loopback LocalStack only.");
const config = { endpoint, region: "us-east-1", credentials: { accessKeyId: randomBytes(12).toString("hex"), secretAccessKey: randomBytes(24).toString("hex") }, maxAttempts: 1 };
const bytes = readFileSync(`${dir}/enricher.zip`);
const metadata = JSON.parse(readFileSync(`${dir}/artifact.json`, "utf8"));
if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("Package changed after binding.");
const suffix = randomBytes(6).toString("hex"), bucket = `zn-mixed-${suffix}`, name = `zn-mixed-enricher-${suffix}`, key = `functions/${metadata.sha256}.zip`;
const s3 = new S3Client({ ...config, forcePathStyle: true });
const iam = new IAMClient(config); const lambda = new LambdaClient(config);
try {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  const upload = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ChecksumSHA256: Buffer.from(metadata.sha256, "hex").toString("base64") }));
  if (!upload.VersionId || upload.VersionId === "null") throw new Error("S3 version pin missing.");
  const role = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  if (!role.Role?.Arn) throw new Error("Execution role missing.");
  const created = await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Handler: "enricher/handler.handler", Role: role.Role.Arn, Publish: true, Code: { S3Bucket: bucket, S3Key: key, S3ObjectVersion: upload.VersionId }, MemorySize: 128, Timeout: 10 }));
  if (!created.FunctionArn || !/^[1-9][0-9]*$/.test(created.Version ?? "")) throw new Error("Published version missing.");
  const functionArn = `${created.FunctionArn}:${created.Version}`;
  // Wait for real readiness; absence never becomes a passing fixture.
  let active = false;
  for (let i = 0; i < 60; i++) {
    const actual = await lambda.send(new GetFunctionCommand({ FunctionName: functionArn }));
    if (actual.Configuration?.CodeSha256 !== Buffer.from(metadata.sha256, "hex").toString("base64")) throw new Error("Lambda code digest differs.");
    if (actual.Configuration.State === "Active") { active = true; break; }
    if (actual.Configuration.State === "Failed") throw new Error("Lambda creation failed.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!active) throw new Error("Lambda was not ready before timeout.");
  writeFileSync(`${dir}/local-credentials.json`, JSON.stringify(config.credentials), { mode: 0o600 });
  writeFileSync(output, JSON.stringify({ bucket, key, version: upload.VersionId, functionArn, sha256: metadata.sha256, sourceDigest: metadata.sourceDigest }, null, 2) + "\n");
  console.log(JSON.stringify({ bucket, functionArn, version: upload.VersionId, sha256: metadata.sha256 }));
} finally { s3.destroy(); iam.destroy(); lambda.destroy(); }
