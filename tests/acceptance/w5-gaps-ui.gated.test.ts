/** Real browser and authenticated local server; Mac verifier only, no route mocks. */
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { isAbsolute } from "node:path";

describe.skipIf(process.env.ZENITH_TEST_W5_GAPS_UI !== "1")("W5 gaps UI [owned local server and browser]", () => {
  it("shows the actual billing source and separate restore milestones; readiness still requires its bearer", async () => {
    const base = new URL(process.env.ZENITH_W5_GAPS_BASE_URL ?? "");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(base.hostname);
    expect(base.username || base.password).toBe("");
    const state = process.env.ZENITH_W5_GAPS_STORAGE_STATE_FILE;
    expect(state && isAbsolute(state), "Private authenticated operator browser state file required").toBe(true);
    const slug = process.env.ZENITH_W5_GAPS_PROJECT_SLUG ?? "";
    expect(slug).toMatch(/^[a-z0-9-]{1,80}$/);
    const browser = await chromium.launch({ headless: true, ...(process.env.ZENITH_TEST_BROWSER_BIN ? { executablePath: process.env.ZENITH_TEST_BROWSER_BIN } : { channel: "chrome" }) });
    try {
      const context = await browser.newContext({ storageState: state });
      const page = await context.newPage();
      await page.goto(new URL(`/p/${slug}/settings`, base).href);
      await page.getByRole("heading", { name: "Managed hosting tier", exact: true }).waitFor();
      const response = await context.request.get(new URL("/api/platform/v1/billing", base).href);
      expect(response.status()).toBe(200);
      const billing = await response.json() as { mode: string; managedTier: string | null; managedTierSource: string };
      await page.getByText(billing.mode === "disabled" ? "selected by operator configuration" : billing.managedTierSource === "billing_assignment" ? "workspace billing assignment" : "assignment required", { exact: false }).waitFor();
      expect(await page.getByRole("heading", { name: "Managed hosting tier" }).locator("..").textContent()).toContain(billing.managedTier ?? "Unknown");
      await page.goto(new URL("/admin/slo", base).href);
      await page.getByRole("heading", { name: "Restore completion evidence" }).waitFor();
      expect(await page.getByRole("region", { name: "Restore milestones" }).textContent()).toMatch(/Database completion:.*First healthy application readiness:/s);
      await page.goto(new URL("/admin/retention", base).href);
      await page.getByText("The restore never guesses keys.", { exact: false }).waitFor();
      const readiness = await context.request.get(new URL("/api/internal/recovery/readiness?restoreRunId=unknown", base).href);
      expect(readiness.status()).toBe(401);
    } finally { await browser.close(); }
  }, 90_000);
});
