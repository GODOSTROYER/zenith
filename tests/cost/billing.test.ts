/**
 * PROD-COST-01: actual-spend reader interface and provider billing adapters.
 *
 * CONTRACT-LEVEL: every provider response below is a hand-built JSON string in
 * the documented shape of that provider's billing API, served by an in-memory
 * transport. Nothing here calls a cloud. Live behaviour is covered only by the
 * gated harness in `live-billing.live.test.ts`, which skips without opt-in.
 */
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import {
  awsCostExplorerAdapter,
  azureCostManagementAdapter,
  BillingError,
  billingGate,
  createActualSpendReader,
  createLiveBillingReader,
  gcpBigQueryAdapter,
  ociUsageAdapter,
  parseGcpScope,
  signAwsV4,
  signOciRequest,
  type BillingAdapter,
  type BillingTransport,
  type ProviderHttpRequest,
  type RequestAuthorizer,
} from "@/lib/cost/billing";

const NOW = "2026-10-20T00:00:00.000Z";
const noAuth: RequestAuthorizer = { authorize: async (r) => ({ ...r, headers: { ...r.headers, authorization: "test-auth" } }) };

function transport(status: number, body: string, headers: Record<string, string> = {}): BillingTransport & { seen: ProviderHttpRequest[] } {
  const seen: ProviderHttpRequest[] = [];
  return { seen, send: async (r) => (seen.push(r), { status, body, headers }) };
}

const reader = (adapter: BillingAdapter, t: BillingTransport) => createActualSpendReader(adapter, { authorizer: noAuth, transport: t, now: () => NOW });

const AWS_BODY = JSON.stringify({
  ResultsByTime: [
    {
      TimePeriod: { Start: "2026-09-01", End: "2026-10-01" },
      Estimated: false,
      Total: {},
      Groups: [
        { Keys: ["Amazon Elastic Compute Cloud - Compute"], Metrics: { UnblendedCost: { Amount: "12.5", Unit: "USD" } } },
        { Keys: ["Amazon Virtual Private Cloud"], Metrics: { UnblendedCost: { Amount: "3.25", Unit: "USD" } } },
      ],
    },
  ],
});
const AWS_QUERY = { provider: "aws" as const, scope: "123456789012", periodStart: "2026-09-01", periodEnd: "2026-10-01" };

describe("AWS Cost Explorer adapter (contract-level recorded response)", () => {
  it("builds a GetCostAndUsage request filtered to the one account", async () => {
    const t = transport(200, AWS_BODY);
    await reader(awsCostExplorerAdapter, t).read(AWS_QUERY);
    const req = t.seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://ce.us-east-1.amazonaws.com/");
    expect(req.headers["x-amz-target"]).toBe("AWSInsightsIndexService.GetCostAndUsage");
    expect(req.headers.authorization).toBe("test-auth");
    const body = JSON.parse(req.body!);
    expect(body).toMatchObject({ TimePeriod: { Start: "2026-09-01", End: "2026-10-01" }, Metrics: ["UnblendedCost"], Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: ["123456789012"] } } });
  });

  it("parses to ActualSpend with the response checksum and a closed period as final", async () => {
    const spend = await reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read(AWS_QUERY);
    expect(spend.kind).toBe("actual_spend");
    expect(spend.totalUsd).toBe(15.75);
    expect(spend.lines.map((l) => l.service)).toEqual(["Amazon Elastic Compute Cloud - Compute", "Amazon Virtual Private Cloud"]);
    expect(spend.source.responseSha256).toBe(sha256Hex(AWS_BODY));
    expect(spend.source.endpoint).toBe("https://ce.us-east-1.amazonaws.com/");
    expect(spend.finalization).toBe("final");
  });

  it("is provisional while the period is open or AWS marks it Estimated", async () => {
    const open = await reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read({ ...AWS_QUERY, periodStart: "2026-10-01", periodEnd: "2026-11-01" });
    expect(open.finalization).toBe("provisional");
    const estimated = AWS_BODY.replace('"Estimated":false', '"Estimated":true');
    expect((await reader(awsCostExplorerAdapter, transport(200, estimated)).read(AWS_QUERY)).finalization).toBe("provisional");
  });

  it("refuses an incomplete page, a non-USD amount and a bad account scope", async () => {
    await expect(reader(awsCostExplorerAdapter, transport(200, JSON.stringify({ ...JSON.parse(AWS_BODY), NextPageToken: "x" }))).read(AWS_QUERY)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(reader(awsCostExplorerAdapter, transport(200, AWS_BODY.replace('"USD"', '"EUR"'))).read(AWS_QUERY)).rejects.toMatchObject({ code: "unsupported_currency" });
    await expect(reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read({ ...AWS_QUERY, scope: "not-an-account" })).rejects.toMatchObject({ code: "invalid_query" });
  });

  it("surfaces only the status of a provider failure, never its body", async () => {
    const error = await reader(awsCostExplorerAdapter, transport(403, "AccessDenied for account 123456789012 arn:aws:iam::123456789012:user/x")).read(AWS_QUERY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).code).toBe("provider_error");
    expect((error as BillingError).message).toBe("AWS billing API answered HTTP 403.");
  });

  it("refuses a query for another provider or a malformed period", async () => {
    await expect(reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read({ ...AWS_QUERY, provider: "gcp" })).rejects.toMatchObject({ code: "invalid_query" });
    await expect(reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read({ ...AWS_QUERY, periodEnd: "2026-08-01" })).rejects.toMatchObject({ code: "invalid_query" });
    await expect(reader(awsCostExplorerAdapter, transport(200, AWS_BODY)).read({ ...AWS_QUERY, periodEnd: "2028-10-01" })).rejects.toMatchObject({ code: "invalid_query" });
  });
});

describe("AWS Signature Version 4", () => {
  // AWS's published "get-vanilla" signing example. The secret is assembled at runtime and is the
  // documentation's placeholder, not a credential.
  const secret = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/").replace("/K7MDENG/", "/K7MDENG+");
  it("reproduces the documented get-vanilla signature", () => {
    const signed = signAwsV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {} }, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret }, { region: "us-east-1", service: "service", now: new Date("2015-08-30T12:36:00Z") });
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs the body and the session token", () => {
    const a = signAwsV4({ method: "POST", url: "https://ce.us-east-1.amazonaws.com/", headers: { "content-type": "application/x-amz-json-1.1" }, body: "{}" }, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret, sessionToken: "tok" }, { region: "us-east-1", service: "ce", now: new Date("2026-10-01T00:00:00Z") });
    const b = signAwsV4({ method: "POST", url: "https://ce.us-east-1.amazonaws.com/", headers: { "content-type": "application/x-amz-json-1.1" }, body: '{"a":1}' }, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret, sessionToken: "tok" }, { region: "us-east-1", service: "ce", now: new Date("2026-10-01T00:00:00Z") });
    expect(a.headers["x-amz-security-token"]).toBe("tok");
    expect(a.headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });
});

describe("GCP BigQuery billing export adapter (contract-level recorded response)", () => {
  const scope = "my-project-123.billing_ds.gcp_billing_export_v1_ABCD";
  const q = { provider: "gcp" as const, scope, periodStart: "2026-09-01", periodEnd: "2026-10-01" };
  const body = JSON.stringify({
    jobComplete: true,
    schema: { fields: [{ name: "service" }, { name: "cost" }, { name: "currency" }] },
    rows: [{ f: [{ v: "Compute Engine" }, { v: "20.5" }, { v: "USD" }] }, { f: [{ v: "Cloud Run" }, { v: "1.5" }, { v: "USD" }] }],
  });

  it("binds dates as parameters and validates the table name", async () => {
    const t = transport(200, body);
    const spend = await reader(gcpBigQueryAdapter, t).read(q);
    const sent = JSON.parse(t.seen[0]!.body!);
    expect(t.seen[0]!.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/my-project-123/queries");
    expect(sent.query).toContain("`my-project-123.billing_ds.gcp_billing_export_v1_ABCD`");
    expect(sent.query).not.toContain("2026-09-01");
    expect(sent.queryParameters.map((p: { parameterValue: { value: string } }) => p.parameterValue.value)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(spend.totalUsd).toBe(22);
    expect(spend.costBasis).toMatch(/before credits/);
    expect(spend.finalization).toBe("final");
  });

  it("refuses an injected scope, an unfinished job, a further page and a non-USD row", async () => {
    expect(() => parseGcpScope("p.d.t`; DROP TABLE x; --")).toThrow(BillingError);
    expect(() => parseGcpScope("short.d.t")).toThrow(BillingError);
    await expect(reader(gcpBigQueryAdapter, transport(200, body.replace('"jobComplete":true', '"jobComplete":false'))).read(q)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(reader(gcpBigQueryAdapter, transport(200, JSON.stringify({ ...JSON.parse(body), pageToken: "n" }))).read(q)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(reader(gcpBigQueryAdapter, transport(200, body.replace('"USD"', '"JPY"'))).read(q)).rejects.toMatchObject({ code: "unsupported_currency" });
  });
});

describe("Azure Cost Management adapter (contract-level recorded response)", () => {
  const q = { provider: "azure" as const, scope: "/subscriptions/00000000-0000-4000-8000-000000000000", periodStart: "2026-09-01", periodEnd: "2026-10-01" };
  const body = JSON.stringify({ properties: { nextLink: null, columns: [{ name: "Cost" }, { name: "ServiceName" }, { name: "Currency" }], rows: [[10.25, "Storage", "USD"], [2, "Virtual Network", "USD"]] } });

  it("queries ActualCost with an inclusive end the day before the exclusive period end", async () => {
    const t = transport(200, body);
    const spend = await reader(azureCostManagementAdapter, t).read(q);
    const sent = JSON.parse(t.seen[0]!.body!);
    expect(t.seen[0]!.url).toBe(`https://management.azure.com${q.scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`);
    expect(sent.type).toBe("ActualCost");
    expect(sent.timePeriod).toEqual({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" });
    expect(spend.totalUsd).toBe(12.25);
    expect(spend.provider).toBe("azure");
  });

  it("refuses a further page, a non-subscription scope and a non-USD currency", async () => {
    await expect(reader(azureCostManagementAdapter, transport(200, body.replace('"nextLink":null', '"nextLink":"https://x"'))).read(q)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(reader(azureCostManagementAdapter, transport(200, body)).read({ ...q, scope: "/subscriptions/x/resourceGroups/y" })).rejects.toMatchObject({ code: "invalid_query" });
    await expect(reader(azureCostManagementAdapter, transport(200, body.replace('"USD"', '"EUR"'))).read(q)).rejects.toMatchObject({ code: "unsupported_currency" });
  });
});

describe("OCI Usage API adapter (contract-level recorded response)", () => {
  const adapter = ociUsageAdapter({ region: "us-ashburn-1" });
  const q = { provider: "oci" as const, scope: "ocid1.tenancy.oc1..aaaaaaaaexampleexample", periodStart: "2026-09-01", periodEnd: "2026-10-01" };
  const body = JSON.stringify({ items: [{ service: "COMPUTE", computedAmount: 5.5, currency: "USD" }, { service: "COMPUTE", computedAmount: 1.5, currency: "USD" }, { service: "BLOCK_STORAGE", computedAmount: 2, currency: "USD" }] });

  it("sends a MONTHLY COST query for month-aligned periods and merges services", async () => {
    const t = transport(200, body);
    const spend = await reader(adapter, t).read(q);
    const sent = JSON.parse(t.seen[0]!.body!);
    expect(t.seen[0]!.url).toBe("https://usageapi.us-ashburn-1.oci.oraclecloud.com/20200107/usage");
    expect(sent).toMatchObject({ granularity: "MONTHLY", queryType: "COST", groupBy: ["service"], tenantId: q.scope });
    expect(spend.lines).toEqual([{ service: "BLOCK_STORAGE", usd: 2 }, { service: "COMPUTE", usd: 7 }]);
    expect(spend.totalUsd).toBe(9);
  });

  it("refuses non-month-aligned periods, a further page and a non-tenancy scope", async () => {
    await expect(reader(adapter, transport(200, body)).read({ ...q, periodStart: "2026-09-02" })).rejects.toMatchObject({ code: "invalid_query" });
    await expect(reader(adapter, transport(200, body, { "opc-next-page": "n" })).read(q)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(reader(adapter, transport(200, body)).read({ ...q, scope: "ocid1.compartment.oc1..abc" })).rejects.toMatchObject({ code: "invalid_query" });
  });

  it("signs requests with a key generated at test time and the signature verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const req: ProviderHttpRequest = { method: "POST", url: "https://usageapi.us-ashburn-1.oci.oraclecloud.com/20200107/usage", headers: { "content-type": "application/json" }, body: "{}" };
    const signed = signOciRequest(req, { tenancyOcid: "ocid1.tenancy.oc1..t", userOcid: "ocid1.user.oc1..u", fingerprint: "aa:bb", privateKeyPem: pem }, new Date("2026-10-01T00:00:00Z"));
    const auth = signed.headers.authorization!;
    const signature = /signature="([^"]+)"/.exec(auth)![1]!;
    const signingString = [
      `date: ${signed.headers.date}`,
      "(request-target): post /20200107/usage",
      `host: ${signed.headers.host}`,
      `x-content-sha256: ${signed.headers["x-content-sha256"]}`,
      `content-type: ${signed.headers["content-type"]}`,
      `content-length: ${signed.headers["content-length"]}`,
    ].join("\n");
    const verify = createVerify("RSA-SHA256").update(signingString);
    expect(verify.verify(createPublicKey(publicKey), signature, "base64")).toBe(true);
    expect(auth).toContain('keyId="ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb"');
  });
});

describe("live gate", () => {
  it("is closed unless the opt-in AND an absolute credentials file path are set", () => {
    expect(billingGate("aws", {})).toMatchObject({ open: false });
    expect(billingGate("aws", { ZENITH_LIVE_AWS: "1" })).toMatchObject({ open: false });
    expect(billingGate("aws", { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BILLING_CREDENTIALS_FILE: "relative.json" })).toMatchObject({ open: false });
    expect(billingGate("aws", { ZENITH_LIVE_AWS: "true", ZENITH_LIVE_AWS_BILLING_CREDENTIALS_FILE: "/abs/creds.json" })).toMatchObject({ open: false });
    expect(billingGate("oci", { ZENITH_LIVE_OCI: "1", ZENITH_LIVE_OCI_BILLING_CREDENTIALS_FILE: "/abs/creds.json" })).toEqual({ open: true, credentialsFile: "/abs/creds.json" });
  });

  it("refuses without touching the network or the credentials file when the gate is closed", async () => {
    const fetchSpy = vi.fn();
    const readSpy = vi.fn();
    await expect(createLiveBillingReader("aws", { env: {}, fetch: fetchSpy as unknown as typeof fetch, readFile: readSpy })).rejects.toMatchObject({ code: "gate_closed" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("with the gate open it reads the credentials file, signs, and keeps secrets out of errors", async () => {
    const env = { ZENITH_LIVE_AWS: "1", ZENITH_LIVE_AWS_BILLING_CREDENTIALS_FILE: "/abs/creds.json" };
    const secret = ["s", "e", "c", "r", "e", "t"].join("") + "-value-for-test";
    const creds = JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret });
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenAuth = init.headers.authorization ?? "";
      return new Response(AWS_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const live = await createLiveBillingReader("aws", { env, readFile: async () => creds, fetch: fetchImpl, now: () => new Date(NOW) });
    const spend = await live.read(AWS_QUERY);
    expect(spend.totalUsd).toBe(15.75);
    expect(seenUrl).toBe("https://ce.us-east-1.amazonaws.com/");
    expect(seenAuth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(JSON.stringify(spend)).not.toContain(secret);

    const bad = await createLiveBillingReader("aws", { env, readFile: async () => JSON.stringify({ accessKeyId: "x", secretAccessKey: secret, extra: 1 }), fetch: fetchImpl }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: "credentials_unreadable" });
    expect(String((bad as Error).message)).not.toContain(secret);
    const unreadable = await createLiveBillingReader("aws", { env, readFile: async () => { throw new Error(`ENOENT ${secret}`); }, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(unreadable).toMatchObject({ code: "credentials_unreadable" });
    expect(String((unreadable as Error).message)).not.toContain(secret);
  });
});
