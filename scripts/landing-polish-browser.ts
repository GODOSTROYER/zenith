/** Run against a real production build: npx tsx scripts/landing-polish-browser.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { verifyLandingFocus } from "./landing-focus-browser";

const require = createRequire(import.meta.url);
const output = resolve(process.env.LANDING_QA_DIR || join(tmpdir(), "zenith-landing-visual"));
const url = "http://127.0.0.1:3400";
const widths = [320, 390, 768, 1024, 1440, 2048];
const results: Record<string, unknown>[] = [];
let browser: Browser | undefined;

async function checkPage(page: Page) {
  assert.match(await page.title(), /Zenith/i);
  await page.locator("#statement").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-bento]").length === 11);
  await page.evaluate(() => document.fonts.ready);
  // The page can be present under the startup curtain. Trial waits for the
  // unchanged masthead to become hit-testable without activating navigation.
  await page.locator(".zenith-header .zenith-home").click({ trial: true });
  assert.equal(await page.locator("nextjs-portal").count(), 0, "No framework overlay");
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    clipped: [...document.querySelectorAll<HTMLElement>("[data-bento]")].filter((card) => card.scrollWidth > card.clientWidth + 2).map((card) => card.id),
    fonts: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
  }));
  assert.ok(layout.overflow <= 2, `Page overflow: ${layout.overflow}`);
  assert.deepEqual(layout.clipped, [], `Clipped cards: ${layout.clipped.join(", ")}`);
  assert.ok(layout.fonts.length > 0, "Actual bundled fonts must load");
  return layout;
}

/** Let native lazy loading complete before a long element screenshot jumps past logos. */
async function loadVisibleLogos(page: Page) {
  for (const logo of await page.locator("[data-cloud-logo]:visible").all()) {
    await logo.scrollIntoViewIfNeeded();
    await logo.evaluate(async (element) => { await (element as HTMLImageElement).decode(); });
    assert.equal(await logo.evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    }), true, "Every displayed vendor logo must decode before capture");
  }
}

async function interactions(page: Page) {
  const view = page.locator('#before [data-micro-group="view"]');
  await view.getByRole("button", { name: "Current", exact: true }).click();
  assert.equal(await page.locator("#before button[data-new]").count(), 0);
  const current = await page.locator('#scenarios [data-micro-change="number"]').innerText();
  await view.getByRole("button", { name: /^Proposed/ }).click();
  assert.equal(await page.locator("#before button[data-new]").count(), 2);
  assert.notEqual(await page.locator('#scenarios [data-micro-change="number"]').innerText(), current);
  for (const button of await page.locator('#gimbal [data-micro-group="autonomy"] > button').all()) {
    await button.click(); assert.equal(await button.getAttribute("aria-pressed"), "true");
  }
  await page.locator('#ownership button[data-micro-export]').first().click();
  assert.match(await page.locator('#ownership [role="status"]').innerText(), /zenith.manifest.json/);
  for (const button of await page.locator("#foundation [data-micro-foundation] button").all()) {
    await button.click(); assert.equal(await button.getAttribute("aria-pressed"), "true");
  }
  await page.locator("#teams button").last().click();
  assert.match(await page.locator('#teams [role="status"]').innerText(), /more than code/);
  await page.locator("button[data-micro-logo]").first().click();
  assert.equal(await page.locator("#cloud details").evaluate((node) => (node as HTMLDetailsElement).open), true);
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-micro-provider"));
  await page.locator("#cloud summary").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#cloud details").evaluate((node) => (node as HTMLDetailsElement).open), false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#before").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-micro-group="view"]')?.getAttribute("data-micro-ready") === "true");
  for (let index = 0; index < 4; index++) await view.locator("button").nth(index % 2).click();
  // Compare both rectangles in one browser frame. Separate protocol reads can
  // straddle scrolling/GSAP updates; a wall-clock sleep is not animation completion.
  await page.waitForFunction(() => {
    const group = document.querySelector('#before [data-micro-group="view"]');
    const pill = group?.querySelector<HTMLElement>("[data-micro-pill]");
    const selected = group?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!pill || !selected || pill.getAnimations().some((animation) => animation.playState === "running")) return false;
    const a = pill.getBoundingClientRect();
    const b = selected.getBoundingClientRect();
    return a.width > 0 && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2
      && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;
  }, undefined, { timeout: 10000, polling: "raf" });
  await page.locator("[data-agent-loop]").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("[data-agent-loop]")?.getAttribute("data-loop") === "running");
  await page.getByRole("button", { name: "Pause agent flow animation", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-agent-loop]")?.getAttribute("data-loop") === "paused");
  await page.getByRole("button", { name: "Play agent flow animation", exact: true }).click();
  await page.locator("#hosting").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Pause hosting animations", exact: true }).click();
  assert.equal(await page.locator("#cloud").getAttribute("data-user-paused"), "true");
  await page.getByRole("button", { name: "Play hosting animations", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await delay(100);
  const running = await page.locator("#statement").locator("..").evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length);
  assert.equal(running, 0, "Reduced motion must stop bento animation");
}

async function main() {
  await mkdir(output, { recursive: true });
  const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"].find((path) => path && existsSync(path));
  if (!executablePath) throw new Error("Chrome/Chromium missing: browser verification cannot be skipped.");
  const log = createWriteStream(join(output, "server.log"));
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3400"], {
    env: { ...process.env, ZENITH_DATA: join(output, "data"), NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.pipe(log); server.stderr?.pipe(log);
  let serverError: Error | undefined;
  server.on("error", (error) => { serverError = error; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error(`Next exited with ${server.exitCode}; see server.log`);
      try { ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Retry only while starting. */ }
      if (ready) break;
      await delay(500);
    }
    assert.ok(ready, "Production server failed to become ready");
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", hasTouch: width < 720 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const layout = await checkPage(page);
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: join(output, `hero-${width}.png`) });
        await loadVisibleLogos(page);
        await page.locator("#statement").scrollIntoViewIfNeeded();
        // Only section captures hide the fixed masthead so it is not composited over
        // the start of a long element image. The unmodified hero capture above keeps it.
        const captureStyle = ".zenith-header, .zenith-skip { visibility: hidden !important; }";
        await page.locator("#statement").locator("..").screenshot({ path: join(output, `bento-${width}.png`), animations: "disabled", style: captureStyle });
        await page.locator("#cloud").screenshot({ path: join(output, `hosting-${width}.png`), animations: "disabled", style: captureStyle });
        await interactions(page);
      }
      assert.deepEqual(errors, [], `Runtime errors at ${width}px`);
      results.push({ width, ...layout, interactions: width === 1440 || width === 390, errors });
      console.log(`Landing browser PASS: ${width}px`);
      await context.close();
    }
    const nativeFocus = await verifyLandingFocus(browser, url);
    await writeFile(join(output, "results.json"), JSON.stringify({ status: "passed", url, results, nativeFocus }, null, 2));
  } catch (error) {
    await writeFile(join(output, "results.json"), JSON.stringify({ status: "failed", url, results, error: String(error) }, null, 2));
    throw error;
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = once(server, "exit"); server.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    log.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
