/** Production theme gate. Build first, then npm run test:themes.
 * Uses the existing local demo and seed script in an isolated temporary store.
 * A missing browser or a failed check is a failure, never a skipped green gate.
 * Screenshots and JSON are retained for review; no deployment or auth is mocked.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";

const OUT = path.resolve(process.env.ZENITH_THEME_EVIDENCE ?? ".data-theme-evidence");
const THEMES = { light: "Light", dark: "Dark", amoled: "AMOLED Dark" } as const;
type Theme = keyof typeof THEMES;
const GROUNDS = { light: "rgb(244, 243, 238)", dark: "rgb(34, 36, 31)", amoled: "rgb(0, 0, 0)" };
const VIEWPORTS = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };
const ROUTES = ["/overview", "/p/atlas", "/p/atlas/source", "/p/atlas/observe", "/p/atlas/navigator",
  "/p/atlas/deploys", "/p/atlas/revisions", "/p/atlas/security", "/p/atlas/activity", "/p/atlas/settings",
  "/integrations", "/apps", "/apps/new", "/account", "/workspace", "/guide", "/invite",
  "/onboarding", "/login", "/signup", "/forgot-password", "/reset-password", "/", "/waitlist", "/privacy", "/terms", "/admin"];
const SHOTS = new Set(["/overview", "/p/atlas", "/p/atlas/source", "/p/atlas/observe", "/p/atlas/navigator",
  "/p/atlas/settings", "/onboarding", "/login", "/", "/waitlist", "/privacy", "/admin"]);
const results: { name: string; ok: boolean; detail?: string; screenshot?: string }[] = [];
const consoleLog: { page: string; level: string; text: string }[] = [];
const errors = new WeakMap<Page, string[]>();
let base = "";
const filename = (name: string) => name.replace(/[^a-z0-9_-]+/gi, "-");

function observe(page: Page) {
  errors.set(page, []);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on("console", (msg) => {
    if (!["error", "warning"].includes(msg.type())) return;
    consoleLog.push({ page: page.url(), level: msg.type(), text: msg.text() });
    if (msg.type() === "error") errors.get(page)!.push(msg.text());
  });
  page.on("pageerror", (error) => {
    consoleLog.push({ page: page.url(), level: "pageerror", text: error.message });
    errors.get(page)!.push(error.message);
  });
}

async function check(name: string, page: Page, run: () => Promise<void>, screenshot = false) {
  const start = errors.get(page)?.length ?? 0;
  let shot: string | undefined;
  try {
    await run();
    assert.deepEqual(errors.get(page)?.slice(start), [], "Browser console or page error");
    if (screenshot) {
      shot = `${filename(name)}.png`;
      await page.screenshot({ path: path.join(OUT, shot), fullPage: false });
    }
    results.push({ name, ok: true, screenshot: shot });
    console.log(`PASS ${name}`);
  } catch (error) {
    shot = `${filename(name)}-failed.png`;
    await page.screenshot({ path: path.join(OUT, shot), fullPage: false }).catch(() => { shot = undefined; });
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail, screenshot: shot });
    console.error(`FAIL ${name}: ${detail.split("\n")[0]}`);
  }
}

async function rendered(page: Page, route: string) {
  const response = await page.goto(base + route, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, `${route} must render normally`);
  assert.equal(new URL(page.url()).pathname, new URL(base + route).pathname, "Unexpected navigation or auth redirect");
  assert.match(await page.title(), /Zenith/);
  await page.waitForFunction(() => (document.querySelector("main")?.textContent?.trim().length ?? 0) > 25);
  await page.locator(".zenith-boot").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  assert.equal(await page.locator("[data-nextjs-dialog], nextjs-portal").count(), 0);
  assert.equal(await page.getByRole("heading", { name: /Zenith could not start|This screen could not be rendered/ }).count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Document overflows horizontally");
}

async function themeApplied(page: Page, theme: Theme) {
  await page.waitForFunction((value) => (document.documentElement.dataset.theme ?? "dark") === value, theme);
  const expectedBody = new URL(page.url()).pathname === "/" && theme !== "amoled" ? "rgb(8, 9, 13)" : GROUNDS[theme];
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), expectedBody);
  if (theme === "amoled") {
    const ground = await page.evaluate(() => {
      let node: Element | null = document.querySelector("main");
      while (node) {
        const color = getComputedStyle(node).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
        node = node.parentElement;
      }
      return "transparent";
    });
    assert.equal(ground, GROUNDS.amoled, "The visible primary surface must be true black");
  }
}

async function withinViewport(panel: Locator) {
  const fits = await panel.evaluate(async (el) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const rect = el.getBoundingClientRect();
    return rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  });
  assert(fits, "Overlay must remain inside the viewport");
}

async function openThemeMenu(page: Page) {
  if (!(await page.locator('button[aria-label^="Theme:"]:visible').count()))
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator('button[aria-label^="Theme:"]:visible').first().click();
  const menu = page.getByRole("menu", { name: "Theme", exact: true });
  await menu.waitFor();
  assert(await menu.evaluate((el) => el.parentElement === document.body), "Theme menu must portal to the themed body");
  await withinViewport(menu);
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    assert(await menu.getByRole("menuitemradio").evaluateAll((items) => items.every((item) => {
      const rect = item.getBoundingClientRect(); return rect.height >= 44 && rect.width >= 44;
    })), "Mobile theme choices must provide 44px touch targets");
  return menu;
}

async function choose(page: Page, label: string) {
  const menu = await openThemeMenu(page);
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
  await menu.waitFor({ state: "hidden" });
}

async function prepaint(context: BrowserContext, theme: Theme, label: string) {
  const page = await context.newPage();
  observe(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/_next\/.*\.js(?:\?.*)?$/, async (route) => { await gate; await route.continue(); });
  await check(`${label}/pre-hydration`, page, async () => {
    // Blocking external Next scripts leaves the real synchronous head bootstrap
    // running. The assertion observes its paint before React can correct it.
    await page.goto(base + "/overview", { waitUntil: "commit" });
    await page.waitForFunction(() => !!document.body && !!document.querySelector("main"));
    await page.waitForFunction((color) => getComputedStyle(document.body).backgroundColor === color, GROUNDS[theme]);
    await themeApplied(page, theme);
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    release();
    await page.waitForLoadState("domcontentloaded");
    await openThemeMenu(page); // proves the client actually hydrated
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), before);
    await themeApplied(page, theme);
  });
  release();
  await page.close();
}

async function interactions(page: Page, theme: Theme, label: string, mobile: boolean) {
  await check(`${label}/keyboard-and-portals`, page, async () => {
    await rendered(page, "/overview");
    const menu = await openThemeMenu(page);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /^AMOLED Dark/);
    const focus = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    assert(focus.width >= 2 && focus.style !== "none", "Keyboard menu focus must be visible");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    if (mobile) {
      assert.equal(await page.getByRole("dialog").count(), 1, "Closing nested menu must keep its drawer open");
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
    }
    await themeApplied(page, theme);
    await page.getByRole("button", { name: "Search screens and actions", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await withinViewport(dialog);
    assert(await dialog.evaluate((el) => el.parentElement?.parentElement === document.body));
    await page.getByRole("combobox", { name: "Search screens and actions", exact: true }).fill("Source");
    await page.getByRole("option").first().waitFor();
  }, true);
  await check(`${label}/map-and-import-dialog`, page, async () => {
    await rendered(page, "/p/atlas");
    await page.locator(".react-flow__node").first().waitFor();
    assert((await page.locator(".react-flow__edge path").count()) > 0, "Seeded bindings must render");
    assert.equal(await page.locator(".react-flow").evaluate((el) => getComputedStyle(el).backgroundColor), GROUNDS[theme]);
    const node = page.locator('.react-flow__node [role="button"]').first();
    await node.focus();
    await page.keyboard.press("Enter");
    await page.locator('[aria-label="Inspector"], [role="dialog"]').first().waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import into this system", exact: true });
    await dialog.waitFor(); await withinViewport(dialog);
    const input = page.getByRole("textbox", { name: /contents$/ });
    await input.fill("services:\n  web:\n    image: nginx\n");
    assert.equal(await input.inputValue(), "services:\n  web:\n    image: nginx\n");
    await themeApplied(page, theme);
  }, true);
  await check(`${label}/source-editor`, page, async () => {
    await rendered(page, "/p/atlas/source");
    await page.getByRole("radio", { name: "Edit", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Manifest JSON", exact: true });
    const original = await input.inputValue();
    await input.fill(original + "\n");
    await input.press("End");
    assert.equal(await input.inputValue(), original + "\n");
    await themeApplied(page, theme);
    await input.fill(original); // no saved application mutations
  }, true);
  await check(`${label}/logs-and-charts`, page, async () => {
    await rendered(page, "/p/atlas/observe?env=env-staging");
    await page.getByRole("log").first().waitFor();
    await page.getByRole("img", { name: /Lines per minute/ }).waitFor();
    assert((await page.getByRole("meter").count()) > 0);
    const search = page.getByRole("textbox", { name: "Search these log lines", exact: true });
    await search.fill("theme gate missing line");
    await page.getByText("No line matches these filters", { exact: true }).waitFor();
    await search.fill("");
    await page.getByRole("log").first().scrollIntoViewIfNeeded();
    await themeApplied(page, theme);
  }, true);
}

async function syncChecks(context: BrowserContext) {
  const page = await context.newPage(), peer = await context.newPage();
  observe(page); observe(peer);
  await check("preferences/system-cross-tab-fallback", page, async () => {
    await rendered(page, "/login"); await rendered(peer, "/login");
    await choose(page, "System");
    await page.emulateMedia({ colorScheme: "light" }); await themeApplied(page, "light");
    await page.emulateMedia({ colorScheme: "dark" }); await themeApplied(page, "dark");
    await choose(peer, "AMOLED Dark"); await themeApplied(page, "amoled");
    await page.emulateMedia({ colorScheme: "light" }); await themeApplied(page, "amoled");
    await page.reload({ waitUntil: "domcontentloaded" }); await themeApplied(page, "amoled");
    await page.evaluate(() => localStorage.setItem("zenith-theme", "invalid-old-value"));
    await rendered(page, "/overview"); await themeApplied(page, "dark");
    assert.deepEqual(errors.get(peer), [], "Peer page must have no console errors");
  });
  await page.close(); await peer.close();
}

async function browser(): Promise<Browser> {
  const explicit = process.env.CHROME_EXECUTABLE_PATH ?? process.env.ZENITH_BROWSER_EXECUTABLE;
  if (explicit) return chromium.launch({ executablePath: explicit, headless: true });
  const candidates = [{ channel: "chrome" }, { channel: "msedge" },
    ...["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(fs.existsSync).map((executablePath) => ({ executablePath }))];
  const failures: string[] = [];
  for (const options of candidates) {
    try { return await chromium.launch({ ...options, headless: true }); }
    catch (error) { failures.push(String(error)); }
  }
  throw new Error(`No usable installed browser. Set CHROME_EXECUTABLE_PATH.\n${failures.join("\n")}`);
}

async function child(args: string[], env: NodeJS.ProcessEnv) {
  const subprocess = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  subprocess.stdout.on("data", (chunk) => { output += chunk; }); subprocess.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Seed exited ${code}: ${output}`)));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-theme-"));
  let chrome: Browser | undefined, server: ChildProcess | undefined, serverLog = "";
  try {
    assert(fs.existsSync(".next/BUILD_ID"), "Run npm run build before the production browser gate");
    chrome = await browser();
    const env: NodeJS.ProcessEnv = { ...process.env, ZENITH_DATA: data, ZENITH_STORE: "file", ZENITH_FAST: "1", NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" };
    delete env.ZENITH_HOSTED_STORE;
    await child(["--import", "tsx", "scripts/seed.ts"], env);
    const socket = net.createServer();
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    const application = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    server = application;
    let startupError: Error | undefined;
    application.once("error", (error) => { startupError = error; });
    application.stdout.on("data", (chunk) => { serverLog += chunk; }); application.stderr.on("data", (chunk) => { serverLog += chunk; });
    const deadline = Date.now() + 60_000;
    for (;;) {
      assert(!startupError && application.exitCode === null, `Production server exited: ${startupError ?? serverLog}`);
      try { if ((await fetch(base + "/login", { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Starting. */ }
      assert(Date.now() < deadline, `Production server did not become ready: ${serverLog}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const bootstrap = await fetch(base + "/api/bootstrap");
    assert(bootstrap.ok && (await bootstrap.json()).auth?.configured === false,
      "Build this gate's app without NEXT_PUBLIC_SUPABASE_* keys; it exercises the existing local demo");
    for (const [device, viewport] of Object.entries(VIEWPORTS)) for (const theme of Object.keys(THEMES) as Theme[]) {
      const context = await chrome.newContext({ viewport, reducedMotion: "reduce", colorScheme: "light", hasTouch: device === "mobile" });
      const page = await context.newPage(); observe(page);
      const label = `${device}/${theme}`;
      await check(`${label}/select-persist`, page, async () => {
        await rendered(page, "/login"); await choose(page, THEMES[theme]); await themeApplied(page, theme);
        assert.equal(await page.evaluate(() => localStorage.getItem("zenith-theme")), theme);
        await page.reload({ waitUntil: "domcontentloaded" }); await themeApplied(page, theme);
        await page.getByRole("link", { name: "Continue in demo mode", exact: true }).click();
        await page.waitForURL(base + "/overview"); await themeApplied(page, theme);
      });
      await prepaint(context, theme, label);
      for (const route of ROUTES) await check(`${label}/${route === "/" ? "landing" : route.slice(1)}`, page, async () => {
        await rendered(page, route); await themeApplied(page, theme);
      }, SHOTS.has(route));
      await interactions(page, theme, label, device === "mobile");
      if (device === "desktop" && theme === "amoled") await syncChecks(context);
      const pageErrors = errors.get(page) ?? [];
      results.push({ name: `${label}/console-health`, ok: pageErrors.length === 0, detail: pageErrors.join("\n") || undefined });
      await context.close();
    }
  } catch (error) {
    results.push({ name: "environment", ok: false, detail: String(error) });
  } finally {
    await chrome?.close();
    if (server && server.exitCode === null) await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server?.kill("SIGKILL"), 3000);
      server!.once("exit", () => { clearTimeout(timeout); resolve(); });
      server!.kill("SIGTERM");
    });
    fs.writeFileSync(path.join(OUT, "server.log"), serverLog);
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ date: new Date().toISOString(), browser: "installed Chromium via playwright-core", viewports: VIEWPORTS, results, console: consoleLog,
      limitations: ["Seeded local demo; authenticated Supabase/OAuth and hosted runtime details are not exercised.", "Screenshots are evidence for human review, not a pixel-diff baseline."] }, null, 2));
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} theme checks passed. Evidence: ${OUT}`);
  process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
}

void main();
