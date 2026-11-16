/**
 * Gate 12 — the recipient's journey in a real browser.
 *
 * Run:
 *   npx tsx scripts/hosted-browser.ts
 *
 * Not part of `npm test`: it needs a Chrome, Edge, or Chromium binary, which a unit test
 * runner has no business requiring. It is a separate CI step for the same
 * reason, and it **fails** rather than skips when no browser is installed —
 * exit code 2, with the message below. A silent pass here would be the most
 * expensive lie in the suite, because gate 12 is the only one that watches a
 * real rendering engine execute the artifact.
 *
 * What it does, with a synthetic identity-provider fixture and no mocked
 * gateway/build/data modules:
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
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/* Environment first: `@/lib/env` reads ZENITH_DATA on first use, so every
   application module below is imported dynamically, after this block. */
const DATA_DIR = path.join(process.cwd(), ".data-hosted-browser");
process.env.ZENITH_DATA = DATA_DIR;
process.env.ZENITH_FAST = "1";
process.env.ZENITH_BUILD_RUNNER = "recipe-local";
process.env.ZENITH_RUNTIME = "local";
process.env.ZENITH_APP_DOMAIN = "apps.localhost";
process.env.ZENITH_APP_SCHEME = "http";
process.env.ZENITH_SECRET_KEY = "1".repeat(64);
delete process.env.ZENITH_SMTP_URL;

const NO_BROWSER_MESSAGE =
  "gate 12 needs a real browser and found none.\n" +
  "Install Google Chrome, Microsoft Edge, or Chromium on this machine (playwright-core drives the installed\n" +
  "binary, so no browser download is needed), then\n" +
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

  /* The browser journey uses a local identity-provider fixture at the real
     launch route. Opaque, server-created fixture keys keep identities out of
     URLs and the app-host cookie jar; this is synthetic auth, not MFA or a
     provider acceptance claim. */
  const launchRoute = await import("@/app/api/hosted/apps/[appId]/launch/route");
  const fixtureSessions = new Map<string, { subject: string; email: string }>();
  access.setSessionAuthorityForTests(access.supabaseSessionAuthority({
    createClient: (req) => {
      const who = fixtureSessions.get(req?.cookies.get("zenith-browser-fixture")?.value ?? "");
      return { auth: { getUser: async () => ({
        data: { user: who ? { id: who.subject, email: who.email, email_confirmed_at: "2026-01-01T00:00:00.000Z" } : null },
        error: null,
      }) } };
    },
  }));

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
        `${(await release.jobLogs(jobId)).slice(-15).join("\n")}\n`
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

  const server = await journey.startGatewayServer(async (req, params) => {
    const url = new URL(req.url);
    const controlLaunch = /^\/api\/hosted\/apps\/([^/]+)\/launch$/.exec(url.pathname);
    const controlHost = new URL(process.env.ZENITH_CONTROL_ORIGIN!).host;
    if (req.headers.get("host") === controlHost && controlLaunch && req.method === "GET") {
      return launchRoute.GET(req, { params: Promise.resolve({ appId: decodeURIComponent(controlLaunch[1]!) }) });
    }
    return gateway.handleGateway(req, params);
  }, {
    hosts: ["127.0.0.1", "::1"],
  });
  // The control origin carries the port app hostnames are built with, so the
  // exchange redirects land on the server that was just started.
  process.env.ZENITH_CONTROL_ORIGIN = `http://localhost:${server.port}`;
  const appHost = `${SLUG}.apps.localhost:${server.port}`;
  const appOrigin = `http://${appHost}`;
  process.stdout.write(`gateway listening on ${server.bound.join(", ")}:${server.port} as ${appHost}\n`);

  /* ----------------------------- 3. the browser -------------------------- */

  const { chromium } = await import("playwright-core");
  const attempts: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserName = "";
  const closeOwned = async (): Promise<void> => {
    try {
      await browser?.close();
    } finally {
      try {
        await server.close();
      } finally {
        try {
          await data.closeAllAppData();
        } finally {
          fixtureSessions.clear();
          access.setSessionAuthorityForTests(null);
          authority.closeAuthority();
        }
      }
    }
  };
  const candidates: Array<{
    name: string;
    options: Parameters<typeof chromium.launch>[0];
  }> = [
    { name: "chrome", options: { channel: "chrome" } },
    { name: "msedge", options: { channel: "msedge" } },
    ...(fs.existsSync(chromium.executablePath())
      ? [{ name: chromium.executablePath(), options: { executablePath: chromium.executablePath() } }]
      : []),
    ...["/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/chromium"]
      .filter((executablePath) => fs.existsSync(executablePath))
      .map((executablePath) => ({ name: executablePath, options: { executablePath } })),
  ];
  for (const candidate of candidates) {
    try {
      browser = await chromium.launch({ ...candidate.options, headless: true });
      browserName = candidate.name;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "There is no browser installed" and "the browser would not start" are
      // different answers and must not be reported as the same one: only the
      // first is exit 2. Anything else — a sandbox refusal, a missing shared
      // library, a crash on launch — is a failure of this run, and is raised
      // with its own message rather than dressed up as a missing binary.
      if (!/not found|no such file|ENOENT|Chromium distribution/i.test(message)) throw err;
      attempts.push(`${candidate.name}: ${message.split("\n")[0]}`);
    }
  }
  if (!browser) {
    await closeOwned();
    process.stderr.write(`${NO_BROWSER_MESSAGE}\n\ntried:\n  ${attempts.join("\n  ")}\n`);
    return 2;
  }
  process.stdout.write(`driving ${browserName} through playwright-core\n`);

  const addFixtureIdentity = async (
    context: import("playwright-core").BrowserContext,
    identity: { subject: string; email: string }
  ): Promise<void> => {
    const fixtureKey = randomUUID();
    fixtureSessions.set(fixtureKey, identity);
    await context.addCookies([{
      name: "zenith-browser-fixture",
      value: fixtureKey,
      url: `http://localhost:${server.port}`,
      httpOnly: true,
      sameSite: "Lax",
    }]);
  };

  const followSignIn = async (page: import("playwright-core").Page): Promise<void> => {
    const signin = await page.goto(`${appOrigin}/_zenith/auth/signin`, { waitUntil: "domcontentloaded" });
    if (signin?.status() !== 200) throw new Error(`sign-in page answered ${signin?.status() ?? "no response"}`);
    const stateCookie = (await page.context().cookies(appOrigin)).find((one) => one.name === "__Host-zenith_login");
    if (!stateCookie?.httpOnly || !stateCookie.secure) throw new Error("the sign-in page did not mint its HttpOnly Secure browser nonce");
    const launchHref = await page.locator("a.go").getAttribute("href");
    if (!launchHref) throw new Error("the sign-in page did not render its launch link");
    const launchUrl = new URL(launchHref);
    if (launchUrl.origin !== `http://localhost:${server.port}` || launchUrl.searchParams.get("state") !== stateCookie.value) {
      throw new Error("the sign-in link did not carry this browser's nonce to the local control route");
    }
    const final = await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
    if (final?.status() !== 200 || new URL(page.url()).host !== appHost) {
      throw new Error(`the real launch route/callback did not return to the app (${final?.status() ?? "no response"})`);
    }
  };

  // Owner session also follows the real sign-in -> control launch -> callback
  // path, then remains a separate identity for the conflict journey.
  let ownerCookie = "";
  try {
    const ownerContext = await browser.newContext();
    try {
      await addFixtureIdentity(ownerContext, OWNER);
      const ownerPage = await ownerContext.newPage();
      await followSignIn(ownerPage);
      const session = (await ownerContext.cookies(appOrigin)).find((one) => one.name === "__Host-zenith_app");
      if (session) ownerCookie = session.value;
    } finally {
      await ownerContext.close();
    }
  } catch (err) {
    const kind = err instanceof Error ? err.name : "Error";
    process.stderr.write(`the owner's browser launch setup failed (${kind}); nothing else can run\n`);
    await closeOwned();
    return 1;
  }
  if (!ownerCookie) {
    process.stderr.write("the owner's browser launch did not produce an app session cookie; nothing else can run\n");
    await closeOwned();
    return 1;
  }

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
    const grant = await access.grantDirect(
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
    await addFixtureIdentity(context, recipient);
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
      /* --- browser-held nonce through app sign-in and the real launch route --- */
      await followSignIn(page);

      const cookies = await context.cookies();
      const session = cookies.find((one) => one.name === "__Host-zenith_app");
      cookieWasSecure = session ? session.secure : false;
      const sessionFlags = Boolean(
        session && session.secure && session.httpOnly && session.sameSite === "Lax" && session.path === "/"
      );
      record(
        label,
        "the __Host- session cookie is accepted on http://*.localhost",
        sessionFlags,
        session
          ? `secure=${String(session.secure)} httpOnly=${String(session.httpOnly)} sameSite=${session.sameSite} path=${session.path}`
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
      await access.revokeGrant(grant.id, OWNER.subject, "acceptance run: revoked mid-session", { appId: app.id });
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
      const kind = err instanceof Error ? err.name : "Error";
      record(label, "the journey ran to the end", false, `failed (${kind})`);
    } finally {
      await context.close();
    }
  }

  await closeOwned();

  const failed = steps.filter((step) => !step.ok);
  const summary = {
    gate: 12,
    browser: { channel: browserName, engine: "playwright-core chromium" },
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
    const kind = err instanceof Error ? err.name : "Error";
    process.stderr.write(`hosted-browser failed (${kind})\n`);
    process.exit(1);
  });
