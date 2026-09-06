/**
 * Regenerates the README screenshots against a running dev server.
 *
 *   npm run screenshots            # http://localhost:3400, test admin account
 *   ORRERY_URL=… ORRERY_SHOT_EMAIL=… ORRERY_SHOT_PASSWORD=… npm run screenshots
 *
 * Drives the installed Chrome through playwright-core (no browser download),
 * signs in through the real login form, and captures each product screen at
 * a fixed viewport so the images stay comparable between runs. Output lands
 * in docs/screenshots/<name>.png — commit them with the README that shows
 * them. One screen failing never costs the others; failures are listed at
 * the end and the exit code says so.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.ORRERY_URL ?? "http://localhost:3400";
const EMAIL = process.env.ORRERY_SHOT_EMAIL ?? "arnav@orrery.test";
const PASSWORD = process.env.ORRERY_SHOT_PASSWORD ?? "orrery-owner-2026!";
const SLUG = process.env.ORRERY_SHOT_PROJECT ?? "atlas";
const OUT = path.resolve(process.cwd(), "docs/screenshots");
const VIEWPORT = { width: 1440, height: 900 };
/** ORRERY_SHOT_ONLY=navigator,settings re-captures a subset (landing included only when named). */
const ONLY = new Set((process.env.ORRERY_SHOT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const wanted = (name: string) => ONLY.size === 0 || ONLY.has(name);

interface Shot {
  name: string;
  route: string;
  /** runs after the page settled, before the capture */
  before?: (page: Page) => Promise<void>;
  full?: boolean;
}

const waitForMap = async (page: Page) => {
  await page.waitForSelector(".react-flow__node", { timeout: 20_000 });
  await page.waitForTimeout(800); // let dagre settle and edges draw
};

/** name → route, plus an optional step to run before the capture */
const SCREENS: Shot[] = [
  { name: "overview", route: "/overview" },
  { name: "system-map", route: `/p/${SLUG}`, before: waitForMap },
  {
    name: "inspector",
    route: `/p/${SLUG}`,
    before: async (page) => {
      await waitForMap(page);
      // The map honours ?select=<nodeId>, which is how Security links into it;
      // use that rather than fighting React Flow's pointer handling.
      const id = await page.locator(".react-flow__node-service").first().getAttribute("data-id");
      if (!id) throw new Error("no service node on the map to open");
      await page.goto(`${BASE}/p/${SLUG}?select=${id}`, { waitUntil: "domcontentloaded" });
      await waitForMap(page);
      await page.waitForSelector('aside, [role="dialog"]', { timeout: 20_000 });
      await page.waitForTimeout(900);
    },
  },
  { name: "source", route: `/p/${SLUG}/source` },
  { name: "deploys", route: `/p/${SLUG}/deploys` },
  { name: "revisions", route: `/p/${SLUG}/revisions` },
  { name: "observe", route: `/p/${SLUG}/observe`, full: true },
  { name: "security", route: `/p/${SLUG}/security` },
  { name: "activity", route: `/p/${SLUG}/activity` },
  { name: "navigator", route: `/p/${SLUG}/navigator` },
  { name: "settings", route: `/p/${SLUG}/settings`, full: true },
];

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/overview")) return; // already signed in
  await page.waitForSelector('input[type="email"]', { timeout: 60_000 });
  // The form is a client component; clicking before React attaches its
  // handlers submits nothing. Give hydration a beat, then try twice.
  await page.waitForTimeout(1500);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('form button[type="submit"]');
    const left = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (left) return;
    console.log(`  sign-in attempt ${attempt} did not navigate; retrying`);
    await page.waitForTimeout(1500);
  }
  throw new Error(`could not sign in as ${EMAIL} — check the account exists (npm run seed:users) and the password`);
}

async function settle(page: Page): Promise<void> {
  // The product keeps a server-sent-events connection open, so "network idle"
  // never arrives; wait for the shell to hydrate, then a fixed beat for the
  // first payloads so the capture is not a skeleton.
  await page.waitForSelector("main", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/)[0];
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const failures: string[] = [];
  try {
    // Signed-out landing page first, in its own context.
    if (wanted("landing")) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(180_000);
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000); // let the hero assemble the whole system
      await page.screenshot({ path: path.join(OUT, "landing.png"), fullPage: false });
      await ctx.close();
      console.log("✓ landing.png");
    }

    const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
    const page = await ctx.newPage();
    // A dev server compiles each route on first hit, which can take longer
    // than a default navigation timeout; warm every route once, patiently.
    page.setDefaultNavigationTimeout(180_000);
    page.setDefaultTimeout(60_000);
    await signIn(page);
    console.log(`✓ signed in as ${EMAIL}`);
    for (const route of new Set(SCREENS.filter((s) => wanted(s.name)).map((s) => s.route))) {
      const t = Date.now();
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      console.log(`  warmed ${route} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }

    for (const shot of SCREENS.filter((s) => wanted(s.name))) {
      try {
        await page.goto(`${BASE}${shot.route}`, { waitUntil: "domcontentloaded" });
        await settle(page);
        if (shot.before) await shot.before(page);
        await page.screenshot({ path: path.join(OUT, `${shot.name}.png`), fullPage: Boolean(shot.full) });
        console.log(`✓ ${shot.name}.png`);
      } catch (err) {
        failures.push(`${shot.name}: ${firstLine(err)}`);
        console.log(`✗ ${shot.name} — skipped`);
      }
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\nWrote ${fs.readdirSync(OUT).length} images to ${OUT}`);
  if (failures.length) {
    console.error(`${failures.length} screen(s) failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("screenshots failed:", firstLine(err));
  console.error(
    "Fix: start the dev server (npm run dev), seed the test accounts (npm run seed:users), and make sure Chrome is installed."
  );
  process.exit(1);
});
