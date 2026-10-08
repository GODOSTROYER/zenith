/** IAM-authenticated, published-version Lambda endpoint. No ambient credentials or HTTP public fallback. */
import { readFileSync } from "node:fs";
import { LambdaClient, GetFunctionCommand, InvokeCommand } from "@aws-sdk/client-lambda";

export function createLambdaEnricher(env, { client: injected } = {}) {
  const arn = env.ENRICHER_LAMBDA_ARN;
  const match = /^arn:(aws|aws-us-gov|aws-cn):lambda:([a-z0-9-]+):(\d{12}):function:([A-Za-z0-9_-]{1,64}):([1-9][0-9]*)$/.exec(arn ?? "");
  const digest = env.ENRICHER_LAMBDA_SHA256;
  if (!match || !/^[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("Lambda requires a published version ARN and reviewed package SHA-256.");
  const endpoint = env.ENRICHER_LAMBDA_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    if (env.ZENITH_MIXED_LOCALSTACK !== "1" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("A Lambda endpoint override requires explicit loopback LocalStack mode.");
  }
  let client = injected;
  if (!client) {
    if (!env.ENRICHER_LAMBDA_CREDENTIAL_FILE) throw new Error("An explicit scoped Lambda credential file is required.");
    const readCredentials = async () => {
      const c = JSON.parse(readFileSync(env.ENRICHER_LAMBDA_CREDENTIAL_FILE, "utf8"));
      const expiry = c.expiresAt ? Date.parse(c.expiresAt) : undefined;
      if (typeof c.accessKeyId !== "string" || !c.accessKeyId.trim() || typeof c.secretAccessKey !== "string" || !c.secretAccessKey.trim() || (!endpoint && (typeof c.sessionToken !== "string" || !c.sessionToken.trim() || expiry === undefined)) || (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= Date.now()))) throw new Error("Lambda invocation credentials are absent or expired.");
      return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) };
    };
    client = new LambdaClient({ region: match[2], credentials: readCredentials, ...(endpoint ? { endpoint } : {}), maxAttempts: 1 });
  }
  return async payload => {
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > 4096) throw new Error("Lambda request is too large.");
    const signal = AbortSignal.timeout(Number(env.ENRICHER_TIMEOUT_MS ?? 3000));
    const observed = await client.send(new GetFunctionCommand({ FunctionName: arn }), { abortSignal: signal });
    if (observed.Configuration?.CodeSha256 !== Buffer.from(digest, "hex").toString("base64")) throw new Error("Lambda code digest differs from the reviewed artifact.");
    const response = await client.send(new InvokeCommand({ FunctionName: arn, InvocationType: "RequestResponse", LogType: "None", Payload: bytes }), { abortSignal: signal });
    if (response.FunctionError || response.StatusCode !== 200 || response.Payload?.length > 16384 || response.ExecutedVersion !== match[5]) throw new Error("Lambda invocation failed or answered with a different version.");
    const result = JSON.parse(Buffer.from(response.Payload ?? []).toString("utf8"));
    return { status: result.statusCode, body: JSON.parse(result.body), provider: "aws" };
  };
}
