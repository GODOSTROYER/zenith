import { describe, expect, it, vi } from "vitest";
import { createLambdaEnricher } from "../../fixtures/mixed-app/web/lambda.mjs";
import { handler } from "../../fixtures/mixed-app/enricher/handler.mjs";
import { createWebServer } from "../../fixtures/mixed-app/web/server.mjs";
import { createMemoryStore } from "../../fixtures/mixed-app/web/stores.mjs";
import type { AddressInfo } from "node:net";
const sha = "a".repeat(64);
const env = { ENRICHER_LAMBDA_ARN: "arn:aws:lambda:us-east-1:123456789012:function:fixture-enricher:1", ENRICHER_LAMBDA_SHA256: sha };
const payload = { clientKey: "lambda-order", sku: "widget", qty: 2 };
function adapter(over: { digest?: string; error?: string; version?: string } = {}) {
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => command.constructor.name === "GetFunctionCommand"
    ? { Configuration: { CodeSha256: over.digest ?? Buffer.from(sha, "hex").toString("base64") } }
    : { StatusCode: 200, ExecutedVersion: over.version ?? "1", FunctionError: over.error, Payload: Buffer.from(JSON.stringify(await handler(payload))) });
  return { send, invoke: createLambdaEnricher(env, { client: { send } }) };
}
describe("mixed Lambda authenticated invocation adapter [contract]", () => {
  it("uses the exact published ARN and checks its code digest before invocation", async () => {
    const a = adapter(); expect(await a.invoke(payload)).toMatchObject({ status: 200, provider: "aws", body: { priceCents: 500 } });
    expect(a.send.mock.calls.map(c => c[0].input.FunctionName)).toEqual([env.ENRICHER_LAMBDA_ARN, env.ENRICHER_LAMBDA_ARN]);
    expect(a.send.mock.calls[1][0].input).toMatchObject({ InvocationType: "RequestResponse", LogType: "None" });
  });
  it("refuses a changed code digest with zero invoke calls", async () => {
    const a = adapter({ digest: Buffer.from("b".repeat(64), "hex").toString("base64") });
    await expect(a.invoke(payload)).rejects.toThrow(/digest/); expect(a.send).toHaveBeenCalledTimes(1);
  });
  it.each([{ error: "Unhandled" }, { version: "2" }])("does not acknowledge failed or wrong-version execution %j", async over => { await expect(adapter(over).invoke(payload)).rejects.toThrow(/invocation failed/); });
  it("refuses mutable aliases, ambient credentials and non-loopback endpoint overrides", () => {
    expect(() => createLambdaEnricher({ ...env, ENRICHER_LAMBDA_ARN: env.ENRICHER_LAMBDA_ARN.replace(/:1$/, ":latest") })).toThrow(/published/);
    expect(() => createLambdaEnricher(env)).toThrow(/credential file/);
    expect(() => createLambdaEnricher({ ...env, ZENITH_MIXED_LOCALSTACK: "1", ENRICHER_LAMBDA_ENDPOINT: "https://lambda.example.test" }, { client: {} })).toThrow(/loopback/);
  });
  it("the actual web route reaches the Lambda adapter and stores its independently computed result", async () => {
    const a = adapter(); const store = createMemoryStore();
    const server = createWebServer({ store, env: { ...process.env, ENRICHER_MODE: "lambda", WEB_PROVIDER: "gcp" }, invokeLambda: a.invoke });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(201); expect(store.all()[0]).toMatchObject({ ...payload, priceCents: 500, enricherProvider: "aws", webProvider: "gcp" });
      expect(a.send).toHaveBeenCalledTimes(2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
