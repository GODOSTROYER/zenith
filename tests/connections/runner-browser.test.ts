/** Operated local UI/CLI runner-readiness journey. No cloud requests, mocked
 * browser routes, identity stubs or injected stores. Requires the J1/J2 stack. */
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { CreateRunnerInput, RUNNER_CONNECTION_PROVIDERS } from "@/lib/connections/schemas";
import { parseConnectionHandoff } from "@/lib/connections/handoff";
import { runCli } from "@/cli/main";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required when ZENITH_TEST_RUNNER_BROWSER=1.`);
  return value;
};

describe.skipIf(process.env.ZENITH_TEST_RUNNER_BROWSER !== "1")("operated local runner UI (needs J1/J2, Chromium and a browser session)", () => {
  it.each(RUNNER_CONNECTION_PROVIDERS)("CLI initiates; browser human creates, verifies, rotates and revokes a %s runner connection", async provider => {
    const base = new URL(required("ZENITH_TEST_BROWSER_BASE_URL"));
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(base.hostname);
    expect(["http:", "https:"]).toContain(base.protocol);
    const fixtures = JSON.parse(await readFile(required("ZENITH_TEST_RUNNER_BROWSER_INPUT_FILE"), "utf8")) as { cases: { input: unknown; nextRunnerId: string }[] };
    expect(fixtures.cases).toHaveLength(5);
    const cases = fixtures.cases.map(row => ({ input: CreateRunnerInput.parse(row.input), nextRunnerId: row.nextRunnerId }));
    expect(cases.map(row => row.input.provider).sort()).toEqual([...RUNNER_CONNECTION_PROVIDERS].sort());
    const raw = cases.find(row => row.input.provider === provider)!;
    const parsed = CreateRunnerInput.parse(raw.input);
    expect(raw.nextRunnerId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(raw.nextRunnerId).not.toBe(parsed.runnerId);
    const label = `runner-browser-${randomUUID()}`;
    const input = { ...parsed, runnerCustody: parsed.runnerCustody ?? "local_only", label };
    let output = "";
    expect(await runCli(["connections", "create", provider, "--url", base.origin, "--input", "-", "--json"], {
      env: { ZENITH_TOKEN: randomBytes(24).toString("base64url") }, stdin: Readable.from([JSON.stringify(input)]), stdout: text => { output += text; }, stderr: () => undefined,
      fetch: async () => { throw new Error("CLI create must not submit access changes."); },
    })).toBe(3);
    const handoff = JSON.parse(output) as { browserUrl: string };
    expect(JSON.parse(output)).toMatchObject({ approved: false, inputValid: true });
    expect(new URL(handoff.browserUrl).origin).toBe(base.origin);
    expect(parseConnectionHandoff(new URL(handoff.browserUrl).hash).request).toEqual({ action: "connection.createRunner", input });
    const browser = await chromium.launch({ executablePath: required("ZENITH_TEST_CHROMIUM_PATH"), headless: true });
    const context = await browser.newContext({ storageState: required("ZENITH_TEST_BROWSER_STORAGE_STATE") });
    const page = await context.newPage();
    try {
      let submitted = 0;
      page.on("request", request => { if (request.method() === "POST" && request.url() === `${base.origin}/api/platform/v1/connections`) submitted++; });
      await page.goto(handoff.browserUrl);
      await page.getByRole("heading", { name: "Create runner connection", exact: true }).waitFor();
      expect(submitted).toBe(0);
      expect(await page.getByRole("button", { name: "Confirm create runner connection", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("checkbox", { name: "I reviewed these exact identifiers and the selected workspace.", exact: true }).check();
      const saving = page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${base.origin}/api/platform/v1/connections`);
      await page.getByRole("button", { name: "Confirm create runner connection", exact: true }).click();
      const saved = await saving;
      expect(saved.status()).toBe(201);
      const made = await saved.json() as { ok: boolean; data: { connectionId: string } };
      expect(made.ok).toBe(true);
      const id = made.data.connectionId;
      expect(submitted).toBe(1);
      expect(await page.getByRole("button", { name: "Confirm create runner connection", exact: true }).isDisabled()).toBe(true);
      await page.goto(`${base.origin}/platform/connections`);
      // OCI has no product mirror and does not retain the UI label. The two
      // dedicated test runners are the visible nonsecret identifiers.
      let card = page.getByRole("listitem").filter({ hasText: input.runnerId });
      await expect.poll(() => card.count()).toBe(1);
      const mutation = async (suffix: string, click: () => Promise<void>) => {
        const waiting = page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${base.origin}/api/platform/v1/connections/${id}${suffix}`);
        await click();
        const response = await waiting;
        expect(response.status()).toBe(200);
        const answer = await response.json() as { ok: boolean; data: Record<string, unknown> };
        expect(answer.ok).toBe(true);
        return answer;
      };
      const checked = await mutation("/verify", () => card.getByRole("button", { name: "Verify", exact: true }).click());
      expect(checked.data.scope).toContain("permissions remain unverified");
      await card.getByRole("button", { name: "Rotate access", exact: true }).click();
      await card.getByLabel("New runner id", { exact: true }).fill(raw.nextRunnerId);
      await mutation("/rotate", () => card.getByRole("button", { name: "Stage and verify", exact: true }).click());
      const before = await context.request.get(`${base.origin}/api/platform/v1/connections/${id}`);
      expect((await before.json() as { connection: { runnerId: string } }).connection.runnerId).toBe(input.runnerId);
      await mutation("/rotation/promote", () => card.getByRole("button", { name: "Promote new access", exact: true }).click());
      const after = await context.request.get(`${base.origin}/api/platform/v1/connections/${id}`);
      expect((await after.json() as { connection: { runnerId: string } }).connection.runnerId).toBe(raw.nextRunnerId);
      card = page.getByRole("listitem").filter({ hasText: raw.nextRunnerId });
      await expect.poll(() => card.count()).toBe(1);
      await card.getByRole("button", { name: "Revoke", exact: true }).click();
      await card.getByLabel("Type the connection id to confirm", { exact: true }).fill(id);
      await mutation("/revoke", () => card.getByRole("button", { name: "Revoke connection", exact: true }).click());
      const revoked = await context.request.get(`${base.origin}/api/platform/v1/connections/${id}`);
      expect((await revoked.json() as { connection: { status: string } }).connection.status).toBe("revoked");
      // The default list excludes terminally revoked connections.
      await page.goto(`${base.origin}/platform/connections`);
      await expect.poll(() => page.getByRole("listitem").filter({ hasText: raw.nextRunnerId }).count()).toBe(0);

      // Exercise the ordinary create form as well as the CLI confirmation UI.
      const names = { aws: "AWS", gcp: "Google Cloud", azure: "Azure", oci: "Oracle Cloud", kubernetes: "Kubernetes" };
      const labels: Record<string, string> = { accountId: "AWS account id", region: "Region", observeRoleArn: "Observe role ARN", deployRoleArn: "Deploy role ARN", projectId: "Project id", workloadIdentityProvider: "Workload identity provider", observeServiceAccount: "Observe service account", deployServiceAccount: "Deploy service account", tenantId: "Tenant id", clientId: "Application (client) id", subscriptionId: "Subscription id", cloud: "Azure cloud", tenancyOcid: "Tenancy OCID", compartmentOcid: "Compartment OCID", server: "Kubernetes API origin", namespaces: "Namespaces (comma separated)", runnerId: "Registered runner id", label: "Label", stateBucket: "State bucket (optional)" };
      await page.getByRole("button", { name: names[provider], exact: true }).click();
      if (provider === "gcp" || provider === "azure") await page.getByRole("radio", { name: "Customer runner", exact: true }).check();
      for (const [key, value] of Object.entries(input)) if (labels[key]) await page.getByLabel(labels[key], { exact: true }).fill(Array.isArray(value) ? value.join(", ") : String(value));
      await page.getByLabel("Runner credential custody", { exact: true }).selectOption(input.runnerCustody);
      const formSaving = page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${base.origin}/api/platform/v1/connections`);
      await page.getByRole("button", { name: "Save connection", exact: true }).click();
      const formSaved = await formSaving;
      expect(formSaved.status()).toBe(201);
      const formAnswer = await formSaved.json() as { ok: boolean; data: { connectionId: string } };
      expect(formAnswer.ok).toBe(true);
      expect(JSON.parse(formSaved.request().postData()!)).toEqual(input);
      const formCard = page.getByRole("listitem").filter({ hasText: input.runnerId });
      await expect.poll(() => formCard.count()).toBe(1);
      await formCard.getByRole("button", { name: "Revoke", exact: true }).click();
      await formCard.getByLabel("Type the connection id to confirm", { exact: true }).fill(formAnswer.data.connectionId);
      const formRevoking = page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${base.origin}/api/platform/v1/connections/${formAnswer.data.connectionId}/revoke`);
      await formCard.getByRole("button", { name: "Revoke connection", exact: true }).click();
      const formRevoked = await formRevoking; expect(formRevoked.status()).toBe(200); expect((await formRevoked.json()).ok).toBe(true);
    } finally {
      await context.close(); await browser.close();
    }
  }, 120_000);
});
