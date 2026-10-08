/** Real SDK endpoint proof; never run on this build PC. Live acceptance is deferred. */
import { describe, expect, it } from "vitest";
import { createLambdaEnricher } from "../../fixtures/mixed-app/web/lambda.mjs";
import { handler } from "../../fixtures/mixed-app/enricher/handler.mjs";
const local = process.env.ZENITH_TEST_MIXED_LAMBDA === "1";
const live = process.env.ZENITH_LIVE_AWS_LAMBDA === "1";
const enabled = local || live;
describe.skipIf(!enabled)("mixed Lambda endpoint [needs explicit LocalStack or deferred live AWS gate and credential files]", () => {
  it("real published Lambda returns the fixture checksum through authenticated invocation", async () => {
    expect(local !== live, "Choose exactly one owned LocalStack or live AWS target").toBe(true);
    if (local) expect(process.env.ENRICHER_LAMBDA_ENDPOINT).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/);
    else expect(process.env.ENRICHER_LAMBDA_ENDPOINT).toBeUndefined();
    expect(process.env.ENRICHER_LAMBDA_CREDENTIAL_FILE).toBeTruthy();
    const invoke = createLambdaEnricher({ ...process.env, ...(local ? { ZENITH_MIXED_LOCALSTACK: "1" } : {}) });
    const request = { clientKey: `gated-${Date.now()}`, sku: "widget", qty: 2 };
    const result = await invoke(request);
    const independentlyComputed = await handler(request);
    expect(result).toEqual({ status: independentlyComputed.statusCode, body: JSON.parse(independentlyComputed.body), provider: "aws" });
  }, 60_000);
});
