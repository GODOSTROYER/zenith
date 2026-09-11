/**
 * The body cap and the enforcement table.
 *
 * Two ways past a size limit, so two checks: a declared `Content-Length` that
 * is too big, and a chunked body that declares nothing and only turns out to
 * be too big while it is being read. The second is the one that matters —
 * anyone can omit a header.
 */
import { describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";
import { afterAll } from "vitest";

const dataDir = isolatedDataDir("zenith-quota-body-");

const { DEFAULT_LIMITS, HostedError } = await import("@/lib/hosted/contracts");
const { ENFORCEMENT_LABELS, enforcementFor, readJsonBody } = await import("@/lib/hosted/quota");

afterAll(() => removeDir(dataDir));

const jsonRequest = (body: string, headers: Record<string, string> = {}): Request =>
  new Request("http://apps.localhost/_zenith/data/v1/requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

/** A chunked request: a stream body carries no content-length. */
function streamedRequest(chunks: string[], headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Request("http://apps.localhost/_zenith/data/v1/requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    // Node's fetch requires this for a streamed request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** The thrown value as a HostedError, so a failure names what actually came out. */
async function refusal(read: () => Promise<unknown>): Promise<InstanceType<typeof HostedError>> {
  try {
    await read();
  } catch (error) {
    if (error instanceof HostedError) return error;
    throw error;
  }
  throw new Error("expected the read to be refused, and it was not");
}

describe("readJsonBody", () => {
  it("reads a body inside the limit", async () => {
    const body = await readJsonBody(jsonRequest(JSON.stringify({ writeId: "abc", record: { title: "Laptop" } })));
    expect(body).toEqual({ writeId: "abc", record: { title: "Laptop" } });
  });

  it("refuses a declared content-length over the limit before reading a byte", async () => {
    const request = new Request("http://apps.localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2000000" },
      body: JSON.stringify({ small: true }),
    });
    const error = await refusal(() => readJsonBody(request, 1024));
    expect(error.code).toBe("body_too_large");
    expect(error.status).toBe(413);
    expect(error.fix).toMatch(/1024 bytes/);
    expect(error.details).toMatchObject({ limitBytes: 1024 });
  });

  it("refuses a chunked body that only turns out to be too big while it is read", async () => {
    const chunk = "x".repeat(256);
    const request = streamedRequest(['{"details":"', ...Array.from({ length: 10 }, () => chunk), '"}']);
    expect(request.headers.get("content-length")).toBeNull();

    const error = await refusal(() => readJsonBody(request, 1024));
    expect(error.code).toBe("body_too_large");
    expect(error.status).toBe(413);
  });

  it("accepts a chunked body inside the limit", async () => {
    const request = streamedRequest(['{"title":', '"Monitor"', "}"]);
    expect(await readJsonBody(request, 1024)).toEqual({ title: "Monitor" });
  });

  it("refuses a body that is not JSON", async () => {
    const error = await refusal(() => readJsonBody(jsonRequest("{ not json,")));
    expect(error.code).toBe("invalid_input");
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/not valid JSON/);
  });

  it("refuses an empty body", async () => {
    const error = await refusal(() => readJsonBody(jsonRequest("")));
    expect(error.code).toBe("invalid_input");
  });

  it("refuses a content type that is not JSON, and one that is missing", async () => {
    const wrong = await refusal(() =>
      readJsonBody(
        new Request("http://apps.localhost/x", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      )
    );
    expect(wrong.code).toBe("invalid_input");
    expect(wrong.message).toMatch(/text\/plain/);
    expect(wrong.fix).toMatch(/application\/json/);

    // A string body makes `Request` set text/plain for you, so a request with
    // genuinely no content-type is one with no body at all.
    const missing = await refusal(() => readJsonBody(new Request("http://apps.localhost/x", { method: "POST" })));
    expect(missing.code).toBe("invalid_input");
    expect(missing.message).toMatch(/no content-type header/);
  });

  it("accepts a charset parameter and a +json media type", async () => {
    expect(
      await readJsonBody(jsonRequest('{"ok":1}', { "content-type": "application/json; charset=utf-8" }))
    ).toEqual({ ok: 1 });
    expect(
      await readJsonBody(jsonRequest('{"ok":2}', { "content-type": "application/merge-patch+json" }))
    ).toEqual({ ok: 2 });
  });

  it("defaults to the contract's 1 MB body limit", async () => {
    expect(DEFAULT_LIMITS.bodyBytes).toBe(1_048_576);
    const request = new Request("http://apps.localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(DEFAULT_LIMITS.bodyBytes + 1) },
      body: "{}",
    });
    expect((await refusal(() => readJsonBody(request))).code).toBe("body_too_large");
  });
});

describe("enforcementFor", () => {
  it("says the local runtime does not enforce the provider's CPU and subrequest limits", async () => {
    expect(await enforcementFor("local")).toEqual({
      buildsPerApp: "enforced",
      buildsPilotWide: "enforced",
      buildTimeoutMs: "enforced",
      requestCpuMs: "not_enforced",
      outboundSubrequests: "not_enforced",
      bodyBytes: "enforced",
      requestsPerDay: "enforced",
      storageBytes: "enforced",
    });
  });

  it("attributes CPU and subrequests to the provider on Cloudflare, and nothing else changes", async () => {
    const cloudflare = await enforcementFor("cloudflare");
    expect(cloudflare.requestCpuMs).toBe("provider");
    expect(cloudflare.outboundSubrequests).toBe("provider");

    const local = await enforcementFor("local");
    const rest = Object.keys(local).filter((key) => key !== "requestCpuMs" && key !== "outboundSubrequests");
    for (const key of rest)
      expect(cloudflare[key as keyof typeof cloudflare]).toBe(local[key as keyof typeof local]);
  });

  it("has a sentence for every enforcement state, and none of them claims something untrue", async () => {
    expect(Object.keys(ENFORCEMENT_LABELS).sort()).toEqual(["enforced", "not_enforced", "provider"]);
    expect(ENFORCEMENT_LABELS.not_enforced).toMatch(/Not enforced by this runtime/);
    expect(ENFORCEMENT_LABELS.provider).toMatch(/Cloudflare/);
  });
});
