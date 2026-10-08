/** Operated local UI/CLI runner-readiness journey. No cloud requests, mocked
 * browser routes, identity stubs or injected stores. Requires the J1/J2 stack. */
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { CreateRunnerInput } from "@/lib/connections/schemas";
import { runCli } from "@/cli/main";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required when ZENITH_TEST_RUNNER_BROWSER=1.`);
  return value;
};

describe.skipIf(process.env.ZENITH_TEST_RUNNER_BROWSER !== "1")("operated local runner UI (needs J1/J2, Chromium and a browser session)", () => {
  it("CLI initiates; browser human saves, verifies, rotates and revokes an OCI runner connection", async () => {
    const base = new URL(required("ZENITH_TEST_BROWSER_BASE_URL"));
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(base.hostname);
    expect(["http:", "https:"]).toContain(base.protocol);
    const raw = JSON.parse(await readFile(required("ZENITH_TEST_RUNNER_BROWSER_INPUT_FILE"), "utf8")) as { input: unknown; nextRunnerId: string };
    const parsed = CreateRunnerInput.parse(raw.input);
    if (parsed.provider !== "oci") throw new Error("The existing UI journey supports OCI; other runner UI modes need the documented owner join.");
    expect(raw.nextRunnerId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(raw.nextRunnerId).not.toBe(parsed.runnerId);
    const label = `runner-browser-${randomUUID()}`;
    const input = { ...parsed, label };
    let output = "";
    expect(await runCli(["connections", "create", "oci", "--url", base.origin, "--input", "-", "--json"], {
      env: { ZENITH_TOKEN: randomBytes(24).toString("base64url") }, stdin: Readable.from([JSON.stringify(input)]), stdout: text => { output += text; }, stderr: () => undefined,
      fetch: async () => { throw new Error("CLI create must not submit access changes."); },
    })).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ approved: false, inputValid: true, browserUrl: `${base.origin}/platform/connections` });
    const browser = await chromium.launch({ executablePath: required("ZENITH_TEST_CHROMIUM_PATH"), headless: true });
    const context = await browser.newContext({ storageState: required("ZENITH_TEST_BROWSER_STORAGE_STATE") });
    const page = await context.newPage();
    try {
      await page.goto(`${base.origin}/platform/connections`);
      await page.getByRole("button", { name: "Oracle Cloud", exact: true }).click();
      for (const [name, value] of [["Tenancy OCID", input.tenancyOcid], ["Compartment OCID", input.compartmentOcid], ["Region", input.region], ["Registered runner id", input.runnerId], ["Label", label]]) await page.getByLabel(name, { exact: true }).fill(value);
      const saving = page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${base.origin}/api/platform/v1/connections`);
      await page.getByRole("button", { name: "Save connection", exact: true }).click();
      const saved = await saving;
      expect(saved.status()).toBe(201);
      const made = await saved.json() as { ok: boolean; data: { connectionId: string } };
      expect(made.ok).toBe(true);
      const id = made.data.connectionId;
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
      await expect.poll(() => card.getByRole("button", { name: "Verify", exact: true }).isDisabled()).toBe(true);
    } finally {
      await context.close(); await browser.close();
    }
  }, 120_000);
});
