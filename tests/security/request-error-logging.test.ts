/**
 * API wire/log separation: a generic HTTP error can still leak in server logs.
 * Uses the real errorResponse and logger, intercepting stderr only at its sink.
 * Canary values are synthetic. No production logger/route is modified here.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { errorResponse } from "@/lib/server/errors";
import { withRequestId } from "@/lib/log";
import { assertNoCanaries, canarySecret } from "../_support/security";

const password = canarySecret("request-error/password", "password", { stable: true });
const access = canarySecret("request-error/access", "aws-access-key-id", { stable: true });
let sink: MockInstance<typeof process.stderr.write>;
beforeEach(() => { sink = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => { sink.mockRestore(); });
const logged = () => sink.mock.calls.map((args) => args[0]);
const failure = () => new Error(`upstream refused postgres://admin:${password}@database.test/app ${access}`);

describe("unexpected request errors at wire and log boundaries", () => {
  it("CONTROL: generic HTTP 500 has a request id and no error-message credentials", async () => {
    const response = withRequestId("security-request", () => errorResponse(failure()));
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: { requestId: "security-request" } });
    assertNoCanaries(body, [password, access], "unexpected errors must not disclose credentials in HTTP responses");
    expect(logged(), "the real logger must have written to the captured sink").toHaveLength(1);
  });

  it("SEC-R2 (MED): an unexpected request error must not write credentials to the server log", () => {
    errorResponse(failure());
    assertNoCanaries(logged(), [password, access], "server logs must redact external error messages and stacks, even when the HTTP response is generic");
    // the detail is still there for operators, just without the credentials
    const record = JSON.parse(String(logged()[0])) as { error: { message: string; stack?: string } };
    expect(record.error.message).toContain("upstream refused");
  });
});
