/**
 * Gate 12 — the recipient's journey in a real browser.
 *
 * Run:
 *   npx tsx scripts/hosted-browser.ts
 *
 * Not part of `npm test`: it needs a Chrome or Edge binary, which a unit test
 * runner has no business requiring. It is a separate CI step for the same
 * reason, and it **fails** rather than skips when no browser is installed —
 * exit code 2, with the message below. A silent pass here would be the most
 * expensive lie in the suite, because gate 12 is the only one that watches a
 * real rendering engine execute the artifact.
 *
 * What it does, for real, with no doubles:
 *
 *   1. publishes `fixtures/tracker-app` through the real `recipe-local` runner
 *      into a real content-addressed artifact and activates the release;
 *   2. puts a loopback HTTP server in front of `handleGateway`, so the browser
 *      talks to the same admission pipeline the product does;
 *   3. mints a real exchange for a recipient, opens the callback URL in the
 *      browser, and checks the `__Host-zenith_app` cookie was accepted on
 *      `http://<slug>.apps.localhost:<port>`;
 *   4. creates an equipment request **from the keyboard only** — Tab to the
 *      control, Enter to activate, type, Enter to submit;
 *   5. reloads, and the request is still there;
 *   6. has a second identity change that record through the broker, edits it
 *      in the browser, and checks the conflict is shown and the draft kept;
 *   7. revokes the recipient's grant and navigates again — denied;
 *   8. does all of it at 1280px and again at 375px, collecting console errors.
 *
 * Exit codes: 0 every step passed; 1 a step failed; 2 no browser to run in.
 *
 * Workstream W10 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/* Environment first: `@/lib/env` reads ORRERY_DATA on first use, so every
   application module below is imported dynamically, after this block. */
const DATA_DIR = path.join(process.cwd(), ".data-hosted-browser");
process.env.ORRERY_DATA = DATA_DIR;
process.env.ORRERY_FAST = "1";
process.env.ZENITH_BUILD_RUNNER = "recipe-local";
process.env.ZENITH_RUNTIME = "local";
process.env.ZENITH_APP_DOMAIN = "apps.localhost";
process.env.ZENITH_APP_SCHEME = "http";
process.env.ORRERY_SECRET_KEY = "1".repeat(64);
delete process.env.ORRERY_SMTP_URL;

const NO_BROWSER_MESSAGE =
  "gate 12 needs a real browser and found none.\n" +
  "Install Google Chrome or Microsoft Edge on this machine (playwright-core drives the installed\n" +
  "binary through `chromium.launch({ channel: \"chrome\" })`, so no browser download is needed), then\n" +
  "run `npx tsx scripts/hosted-browser.ts` again. This step is not skipped when a browser is missing:\n" +
  "nothing about the recipient's journey in a rendering engine has been verified.";

const SLUG = "alpha";
const OWNER = { subject: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };

/** One recorded step of the run. */
interface Step {
  viewport: string;
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
const record = (viewport: string, name: string, ok: boolean, detail: string): boolean => {
  steps.push({ viewport, name, ok, detail });
  process.stdout.write(`${ok ? "  ok  " : " FAIL "} [${viewport}] ${name} — ${detail}\n`);
  return ok;
};

/** A console message that is the browser reporting an HTTP status we asked for. */
const EXPECTED_NETWORK_LOG = /Failed to load resource.*(401|403|409)/i;

async function main(): Promise<number> {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const journey = await import("../tests/hosted/acceptance/_journey");
  const authority = await import("@/lib/hosted/authority");
  const access = await import("@/lib/hosted/access");
  const artifacts = await import("@/lib/hosted/artifacts");
  const config = await import("@/lib/hosted/config");
  const data = await import("@/lib/hosted/data");
  const gateway = await import("@/lib/hosted/gateway");
  const release = await import("@/lib/hosted/release");

  authority.openAuthority();

  /* ------------------------- 1. a real published app ---------------------- */

  const app = await release.createApp({
    workspaceId: "ws-browser",
    slug: SLUG,
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });

  const jobId = randomUUID();
  await release.admitPublish({
    jobId,
    appId: app.id,
    workspaceId: app.workspaceId,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "tracker-app" },
  });
  const job = await release.runJobOnce(jobId);
  if (job.status !== "succeeded") {
    process.stderr.write(
      `the publish did not succeed (${job.status} in ${job.phase}): ${job.error ?? "no error recorded"}\n` +
        `${release.jobLogs(jobId).slice(-15).join("\n")}\n`
    );
    return 1;
  }
  const releaseId = String(job.phaseData.releaseId);
  const digest = String(job.phaseData.artifactDigest);
  const store = new artifacts.FsArtifactStore(config.hostedConfig().artifactDir);
  const verdict = await store.verify(digest);
  process.stdout.write(
    `published release ${String(job.phaseData.releaseNumber)} (${releaseId})\n` +
      `artifact ${digest} — ${verdict.detail}\n`
  );

  /* ------------------------ 2. a loopback app host ----------------------- */

  const server = await journey.startGatewayServer(gateway.handleGateway, {
    hosts: ["127.0.0.1", "::1"],
  });
  // The control origin carries the port app hostnames are built with, so the
  // exchange redirects land on the server that was just started.
  process.env.ZENITH_CONTROL_ORIGIN = `http://localhost:${server.port}`;
  const appHost = `${SLUG}.apps.localhost:${server.port}`;
  const appOrigin = `http://${appHost}`;
  process.stdout.write(`gateway listening on ${server.bound.join(", ")}:${server.port} as ${appHost}\n`);

  /* The owner's own session, used for the second-identity conflict. Redeemed
     over the loopback socket rather than in process, so it is a real cookie. */
  const ownerState = `state-${randomUUID()}`;
  const ownerRedirect = new URL(access.createExchange(app.id, OWNER.subject, ownerState).redirect);
  const ownerCallback = await journey.loopbackRequest(server.port, {
    host: appHost,
    path: `${ownerRedirect.pathname}${ownerRedirect.search}`,
  });
  const ownerCookie = /__Host-zenith_app=([^;]+)/.exec(ownerCallback.setCookie.join("\n"))?.[1];
  if (!ownerCookie) {
    process.stderr.write("the owner's exchange did not produce a session cookie; nothing else can run\n");
    await server.close();
    return 1;
  }

  /* ----------------------------- 3. the browser -------------------------- */

  const { chromium } = await import("playwright-core");
  const attempts: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let channel = "";
  for (const candidate of ["chrome", "msedge"]) {
    try {
      browser = await chromium.launch({ channel: candidate, headless: true });
      channel = candidate;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "There is no browser installed" and "the browser would not start" are
      // different answers and must not be reported as the same one: only the
      // first is exit 2. Anything else — a sandbox refusal, a missing shared
      // library, a crash on launch — is a failure of this run, and is raised
      // with its own message rather than dressed up as a missing binary.
      if (!/not found|no such file|ENOENT|Chromium distribution/i.test(message)) throw err;
      attempts.push(`${candidate}: ${message.split("\n")[0]}`);
    }
  }
  if (!browser) {
    await server.close();
    data.closeAllAppData();
    authority.closeAuthority();
    process.stderr.write(`${NO_BROWSER_MESSAGE}\n\ntried:\n  ${attempts.join("\n  ")}\n`);
    return 2;
  }
  process.stdout.write(`driving ${channel} through playwright-core\n`);

  const viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 375, height: 812 },
  ];

  let cookieWasSecure: boolean | null = null;

  for (const viewport of viewports) {
    const label = `${viewport.name} ${viewport.width}px`;
    // A grant of this run's own, so revoking it at the end does not spoil the
    // next viewport's journey.
    const recipient = {
      subject: randomUUID(),
      email: `rae.${viewport.name}@example.test`,
    };
    const grant = access.grantDirect(
      app.id,
      { subject: recipient.subject, email: recipient.email, role: "editor" },
      OWNER.subject
    );
    const title = `Keyboard request ${viewport.name} ${Date.now()}`;

    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.name === "mobile",
      isMobile: false,
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const networkLogs: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (EXPECTED_NETWORK_LOG.test(text)) networkLogs.push(text);
      else consoleErrors.push(text);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      /* --- open the app through the real exchange --- */
      const state = `state-${randomUUID()}`;
      const redirect = access.createExchange(app.id, recipient.subject, state).redirect;
      await page.goto(redirect, { waitUntil: "domcontentloaded" });

      const cookies = await context.cookies();
      const session = cookies.find((one) => one.name === "__Host-zenith_app");
      cookieWasSecure = session ? session.secure : false;
      record(
        label,
        "the __Host- session cookie is accepted on http://*.localhost",
        Boolean(session),
        session
          ? `secure=${String(session.secure)} httpOnly=${String(session.httpOnly)} path=${session.path}`
          : "Chrome did not store the cookie — a __Host- cookie needs a trustworthy origin"
      );

      await page.waitForSelector("h1.app-name", { timeout: 15_000 });
      const heading = (await page.textContent("h1.app-name")) ?? "";
      record(label, "the built app renders on its own host", heading.length > 0, `<h1> reads ${JSON.stringify(heading)}`);

      const footer = (await page.textContent(".footer")) ?? "";
      record(
        label,
        "the page names the release that served it",
        footer.includes(releaseId),
        footer.trim().slice(0, 120)
      );

      /* --- create a request from the keyboard only --- */
      const reached = await tabTo(page, "New request", 40);
      record(label, "Tab reaches the New request control", reached, reached ? "focused it" : "40 tab stops was not enough");
      if (!reached) throw new Error("keyboard navigation could not reach the New request control");

      await page.keyboard.press("Enter");
      await page.waitForSelector("#new-title", { timeout: 10_000 });
      const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
      record(
        label,
        "opening the form moves focus into it",
        focusedId === "new-title",
        `document.activeElement is #${focusedId || "(none)"}`
      );

      await page.keyboard.type(title);
      await page.keyboard.press("Enter");
      const created = await page
        .waitForSelector(`.row-title:text-is(${JSON.stringify(title)})`, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      record(label, "Enter submits the form and the request is saved", created, created ? title : "the row never appeared");
      if (!created) throw new Error("the keyboard-only creation did not produce a row");

      /* --- reload: still there --- */
      await page.reload({ waitUntil: "domcontentloaded" });
      const survived = await page
        .waitForSelector(`.row-title:text-is(${JSON.stringify(title)})`, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      record(label, "the request is still there after a reload", survived, survived ? "read back from the app's database" : "the row was gone");

      /* --- a second identity changes it underneath --- */
      const listed = await journey.loopbackRequest(server.port, {
        host: appHost,
        path: "/_zenith/data/v1/requests?limit=100",
        headers: { cookie: `__Host-zenith_app=${ownerCookie}`, accept: "application/json" },
      });
      const items = (JSON.parse(listed.body) as { items: { id: string; title: string; version: number }[] }).items;
      const mine = items.find((one) => one.title === title);
      if (!mine) throw new Error(`the owner cannot see the record the recipient created (${listed.status})`);

      // Open the drawer and start editing before the other write lands.
      await page.click(`.row-button:has(.row-title:text-is(${JSON.stringify(title)}))`);
      await page.waitForSelector("#edit-title", { timeout: 10_000 });
      const myEdit = `${title} — my unsaved edit`;
      await page.fill("#edit-title", myEdit);

      const patched = await journey.loopbackRequest(server.port, {
        host: appHost,
        path: `/_zenith/data/v1/requests/${mine.id}`,
        method: "PATCH",
        headers: {
          cookie: `__Host-zenith_app=${ownerCookie}`,
          accept: "application/json",
          "content-type": "application/json",
          origin: appOrigin,
        },
        body: JSON.stringify({
          writeId: randomUUID(),
          expectedVersion: mine.version,
          patch: { details: "changed by a second identity" },
        }),
      });
      record(
        label,
        "a second identity changes the record through the broker",
        patched.status === 200,
        `PATCH answered ${patched.status}`
      );

      await page.click("form.form button[type=submit]");
      const conflictShown = await page
        .waitForSelector(".conflict[role=alert]", { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const conflictText = conflictShown ? ((await page.textContent(".conflict")) ?? "") : "";
      record(
        label,
        "the conflict is shown rather than one edit overwriting the other",
        conflictShown && conflictText.includes("Someone changed this"),
        conflictShown ? conflictText.replace(/\s+/g, " ").slice(0, 120) : "no conflict panel appeared"
      );

      const keptDraft = await page.inputValue("#edit-title");
      record(
        label,
        "the draft that was refused is still in the field",
        keptDraft === myEdit,
        `#edit-title holds ${JSON.stringify(keptDraft)}`
      );

      /* --- the grant is revoked --- */
      access.revokeGrant(grant.id, OWNER.subject, "acceptance run: revoked mid-session", { appId: app.id });
      await page.goto(`${appOrigin}/`, { waitUntil: "domcontentloaded" });
      const body = (await page.textContent("body")) ?? "";
      const denied = body.includes("Open this app from Zenith");
      record(
        label,
        "the next navigation after a revocation is refused",
        denied,
        denied ? "landed on the sign-in page" : body.replace(/\s+/g, " ").slice(0, 120)
      );

      /* --- and nothing threw in the page --- */
      record(
        label,
        "no uncaught exception and no unexpected console error",
        consoleErrors.length === 0 && pageErrors.length === 0,
        `console=${consoleErrors.length} pageerror=${pageErrors.length}` +
          (networkLogs.length > 0
            ? ` (${networkLogs.length} expected status log(s) from the refusals above)`
            : "")
      );
      for (const message of [...consoleErrors, ...pageErrors])
        process.stdout.write(`        console: ${message}\n`);
    } catch (err) {
      record(label, "the journey ran to the end", false, err instanceof Error ? err.message : String(err));
    } finally {
      await context.close();
    }
  }

  await browser.close();
  await server.close();
  data.closeAllAppData();
  authority.closeAuthority();

  const failed = steps.filter((step) => !step.ok);
  const summary = {
    gate: 12,
    browser: { channel, engine: "playwright-core chromium" },
    app: { slug: SLUG, releaseId, artifactDigest: digest },
    server: { port: server.port, bound: server.bound, host: appHost },
    secureCookieAcceptedOnHttpLocalhost: cookieWasSecure,
    viewports: viewports.map((one) => `${one.width}x${one.height}`),
    steps,
    passed: steps.length - failed.length,
    failed: failed.length,
    result: failed.length === 0 ? "pass" : "fail",
  };
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * Press Tab until the focused element's accessible text contains `label`.
 *
 * Deliberately not `locator.focus()`: gate 12 asks whether a keyboard can
 * *reach* the control, and a programmatic focus would answer a different
 * question.
 */
async function tabTo(
  page: import("playwright-core").Page,
  label: string,
  maxStops: number
): Promise<boolean> {
  for (let stop = 0; stop < maxStops; stop++) {
    await page.keyboard.press("Tab");
    const text = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? "");
    if (text.trim().toLowerCase() === label.toLowerCase()) return true;
  }
  return false;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`hosted-browser failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
