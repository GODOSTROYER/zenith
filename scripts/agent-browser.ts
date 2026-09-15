/**
 * The approval screen, in a real browser.
 *
 * Run:
 *   npm run agent:browser
 *
 * This is the gate over the one surface where the user's consent is actually
 * collected. Everything else in this feature can be proved by a suite; whether
 * a person can *see what they are agreeing to*, reach the controls from a
 * keyboard, and have the terminal come back to life when they press Approve
 * can only be proved in a rendering engine.
 *
 * Modelled on `scripts/hosted-browser.ts` (gate 12) and run in the same job
 * shape: a real Chrome, Edge or Chromium driven through `playwright-core`
 * against the *installed* binary, never `continue-on-error`, and **exit 2 —
 * a failure — when no browser is found**. A skip here would be a green run in
 * which nothing about the consent screen was verified.
 *
 * ## What it does, for real
 *
 *   1. seeds a workspace, a project and an environment in its own ZENITH_DATA;
 *   2. starts a **real Next.js dev server** on a port it owns, with a loopback
 *      identity-provider double as NEXT_PUBLIC_SUPABASE_URL — the same single
 *      double `scripts/agent-acceptance.ts` uses, and for the same reason:
 *      `verifyRequestIdentity` refuses rather than admitting an unverified
 *      session, and that behaviour is being kept, not worked around;
 *   3. opens `/agent/link?code=…` **signed out** and checks the middleware
 *      redirect carries the path *and* the query;
 *   4. signs in by installing the cookie `@supabase/ssr` itself minted, and
 *      checks the screen shows the code, the client name marked unverified,
 *      the workspace picker, the projects, and `read` checked and disabled;
 *   5. walks the form with the Tab key only, to prove every control is
 *      reachable and labelled;
 *   6. presses **Approve**, and then proves the terminal's poll completes —
 *      the browser and the device flow are the same transaction;
 *   7. runs a second link and presses **Deny**, and proves the poll answers
 *      `access_denied`;
 *   8. does the render checks at 380 px (UI-5) and 1280 px (UI-4), collecting
 *      console errors, and asserts the page never scrolls sideways.
 *
 * ## The contract with packet P1's markup
 *
 * A browser gate has to name things. Everything this script looks for is an
 * **accessible name or role**, never a class or a DOM path, and the list is
 * `PAGE` below. That list is the contract between this gate and the approval
 * screen: if P1 needs a different word, it changes there and in
 * `docs/AGENT-LINK.md` together. Assertions on `.some-class` would have made
 * the gate a restyling tax; assertions on the accessible name are the same
 * thing a screen-reader user depends on.
 *
 * Exit codes: 0 every step passed; 1 a step failed; 2 no browser to run in.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

const DATA_DIR = path.join(process.cwd(), ".data-agent-browser");

process.env.ZENITH_DATA = DATA_DIR;
process.env.ZENITH_FAST = "1";
process.env.ZENITH_AGENT_CONTROL = "1";
process.env.ZENITH_AGENT_WRITES = "1";
process.env.ZENITH_AGENT_CREDENTIAL_FILE = path.join(DATA_DIR, "agent-authority", "credentials.json");
process.env.ZENITH_SECRET_KEY = "8".repeat(64);
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "browser-gate-publishable-key";
delete process.env.ZENITH_STORE;
delete process.env.ZENITH_HOSTED_STORE;

const WORKSPACE = "ws-agent-browser";
const OWNER = { subject: "b1b2c3d4-0000-4000-8000-00000000ada0", email: "ada@zenith.test", name: "Ada" };

/**
 * The accessible names and roles the approval screen must expose.
 *
 * Read the file header before changing anything here.
 */
const PAGE = {
  /** The heading that tells a person what they are being asked. */
  heading: /link (a|an) .*agent|approve .*access|connect .*agent/i,
  /** The note that the client name came from the program, not from us. */
  unverifiedNote: /not verified|supplied by the program/i,
  /** The sentence that says approving is not deploying. */
  reassurance: /does not deploy anything/i,
  workspacePicker: /workspace/i,
  projectSelect: /project/i,
  expiry: /expir|days/i,
  // The primary control says what it does ("Approve and issue a credential");
  // match the leading verb, not an exact label, so copy can stay descriptive.
  approve: /^approve/i,
  deny: /^deny/i,
  approved: /you can go back to your terminal/i,
} as const;

/** The six scopes, and what the screen must do with each by default. */
const SCOPES = [
  { name: "read", checked: true, locked: true },
  { name: "plan", checked: true, locked: false },
  { name: "write", checked: true, locked: false },
  { name: "logs", checked: false, locked: false },
  { name: "export", checked: false, locked: false },
  { name: "publish", checked: false, locked: false },
] as const;

/**
 * The default expiry the screen offers.
 *
 * The integrator's decision is **30 days, ceiling 30**. PLAN2/WORK-GRAPH-2.md
 * F11 still writes "default 7" and PLAN2/LINK-PROTOCOL.md §2.2 still writes
 * "1 / 7 / 30, default 7". This gate asserts the decision, so that if the page
 * ships the older default the two are reconciled here rather than discovered
 * by a user reading their credential's expiry date.
 */
const DEFAULT_DAYS = 30;

const NO_BROWSER_MESSAGE =
  "the approval-screen gate needs a real browser and found none.\n" +
  "Install Google Chrome, Microsoft Edge, or Chromium on this machine (playwright-core drives the installed\n" +
  "binary, so no browser download is needed), then run `npm run agent:browser` again. This step is not\n" +
  "skipped when a browser is missing: nothing about the screen where a user grants an agent access to their\n" +
  "account has been verified.";

const NO_POSIX_MESSAGE =
  "the approval-screen gate needs the file credential authority and this is Windows.\n" +
  "`loadCredentials()` refuses on win32 (src/lib/agent-access/security.ts:52), so an approval has nowhere to\n" +
  "write its credential. Run this on Linux or macOS — CI's `agent` job does. Nothing has been verified here.";

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

/* --------------------------- the identity provider --------------------------- */

/** A JWT auth-js will decode and then validate by asking the provider. */
function accessToken(): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "HS256", typ: "JWT" }),
    part({
      sub: OWNER.subject,
      email: OWNER.email,
      aud: "authenticated",
      role: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      user_metadata: { full_name: OWNER.name },
      app_metadata: {},
    }),
    Buffer.alloc(32, 9).toString("base64url"),
  ].join(".");
}

async function startIdentityProvider(token: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (url.pathname === "/auth/v1/user") {
      if ((req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") !== token)
        return send(401, { message: "invalid claim: missing sub claim", code: 401 });
      return send(200, {
        id: OWNER.subject,
        aud: "authenticated",
        role: "authenticated",
        email: OWNER.email,
        email_confirmed_at: "2026-01-01T00:00:00.000Z",
        user_metadata: { full_name: OWNER.name },
        app_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
    send(404, { message: `the gate's identity provider does not serve ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A free TCP port, asked for by binding one and letting it go. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/* --------------------------------- the run ---------------------------------- */

async function main(): Promise<number> {
  if (process.platform === "win32") {
    process.stderr.write(`${NO_POSIX_MESSAGE}\n`);
    return 2;
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, "agent-authority"), { recursive: true, mode: 0o700 });

  const token = accessToken();
  const provider = await startIdentityProvider(token);
  process.env.NEXT_PUBLIC_SUPABASE_URL = provider.origin;

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  process.env.ZENITH_AGENT_ORIGIN = origin;

  /* ----------------------------- 1. a seeded workspace --------------------- */

  const store = await import("@/lib/db/store");
  const { runAction } = await import("@/lib/actions/core");
  const { registerAllActions } = await import("@/lib/actions/defs");

  registerAllActions();
  store.resetDb();
  const at = new Date().toISOString();
  const db = store.db();
  db.workspaces.push({ id: WORKSPACE, name: "Consent", slug: "consent", createdAt: at });
  db.members.push({
    id: OWNER.subject,
    workspaceId: WORKSPACE,
    name: OWNER.name,
    email: OWNER.email,
    role: "admin",
  });
  db.connections.push({
    id: "conn-browser",
    workspaceId: WORKSPACE,
    provider: "sandbox",
    label: "Sandbox",
    region: "local-1",
    status: "healthy",
    grantedPermissions: [],
    createdAt: at,
  });
  store.save();

  const actor = { type: "user" as const, id: OWNER.subject, name: OWNER.name };
  const created = await runAction(
    "project.applyBlueprint",
    { workspaceId: WORKSPACE, actor },
    { name: "Consent App", blueprint: "api-worker" },
    { mode: "execute" }
  );
  const projectId = String((created.result?.data as { projectId?: string })?.projectId ?? "");
  await runAction(
    "env.create",
    { workspaceId: WORKSPACE, projectId, actor },
    { name: "sandbox", class: "sandbox", connectionId: "conn-browser", region: "local-1" },
    { mode: "execute" }
  );
  // The store coalesces writes behind a timer; the dev server is a different
  // process and reads the file on boot, so the write has to have landed.
  await store.flushPendingAsync();
  process.stdout.write(`seeded ${WORKSPACE} with project ${projectId} in ${DATA_DIR}\n`);

  /* ------------------------------ 2. a real server ------------------------- */

  const server = await startDevServer(port);
  if (!server) {
    await provider.close();
    return 1;
  }

  /* -------------------------------- 3. a browser --------------------------- */

  const { chromium } = await import("playwright-core");
  const attempts: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserName = "";
  const candidates: Array<{ name: string; options: Parameters<typeof chromium.launch>[0] }> = [
    { name: "chrome", options: { channel: "chrome" } },
    { name: "msedge", options: { channel: "msedge" } },
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
      // different answers: only the first is exit 2.
      if (!/not found|no such file|ENOENT|Chromium distribution/i.test(message)) throw err;
      attempts.push(`${candidate.name}: ${message.split("\n")[0]}`);
    }
  }
  if (!browser) {
    server.stop();
    await provider.close();
    process.stderr.write(`${NO_BROWSER_MESSAGE}\n\ntried:\n  ${attempts.join("\n  ")}\n`);
    return 2;
  }
  process.stdout.write(`driving ${browserName} through playwright-core against ${origin}\n`);

  const cookie = await sessionCookie(provider.origin, token);
  const viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "narrow", width: 380, height: 780 },
  ];

  try {
    for (const viewport of viewports) {
      const label = `${viewport.name} ${viewport.width}px`;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.name === "narrow",
      });
      const consoleErrors: string[] = [];
      context.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      try {
        /* --- signed out: the session gate, with the query intact --- */

        const anonymous = await context.newPage();
        const pending = await startLink(origin);
        await anonymous.goto(`${origin}/agent/link?code=${pending.userCode}`, {
          waitUntil: "domcontentloaded",
        });
        const landed = new URL(anonymous.url());
        record(
          label,
          "signed out, the approval page redirects to /login",
          landed.pathname === "/login",
          `landed on ${landed.pathname}`
        );
        record(
          label,
          "and the redirect carries the code, not only the path",
          landed.searchParams.get("next") === `/agent/link?code=${pending.userCode}`,
          `next=${String(landed.searchParams.get("next"))}`
        );
        await anonymous.close();

        /* --- signed in: what the person is being asked --- */

        await context.addCookies([
          ...cookie.map(([name, value]) => ({ name, value, domain: "localhost", path: "/" })),
        ]);
        const page = await context.newPage();
        await page.goto(`${origin}/agent/link?code=${pending.userCode}`, { waitUntil: "domcontentloaded" });
        // The screen fetches the request after hydration; judge it only once the
        // decision controls exist, otherwise the checks below race the fetch.
        await page
          .getByRole("button", { name: /select all current projects|^deny/i })
          .first()
          .waitFor({ state: "attached", timeout: 30_000 })
          .catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});

        const text = (await page.textContent("body")) ?? "";
        record(
          label,
          "the screen shows the code the terminal is showing",
          text.includes(pending.userCode),
          `looking for ${pending.userCode}`
        );
        record(label, "it names what is being asked", PAGE.heading.test(text), firstMatch(text, PAGE.heading));
        record(
          label,
          "the client name is marked as unverified text a program supplied",
          text.includes("Claude Code") && PAGE.unverifiedNote.test(text),
          firstMatch(text, PAGE.unverifiedNote)
        );
        record(
          label,
          "it says approving is not deploying",
          PAGE.reassurance.test(text),
          firstMatch(text, PAGE.reassurance)
        );
        record(
          label,
          "the workspace and the project are offered by name",
          text.includes("Consent") && text.includes("Consent App"),
          "workspace Consent, project Consent App"
        );

        /* --- the scope checkboxes --- */

        for (const scope of SCOPES) {
          const box = page.getByRole("checkbox", { name: new RegExp(`\\b${scope.name}\\b`, "i") }).first();
          const present = (await box.count()) > 0;
          if (!present) {
            record(label, `the ${scope.name} scope is offered`, false, "no checkbox with that accessible name");
            continue;
          }
          const checked = await box.isChecked();
          const enabled = await box.isEnabled();
          record(
            label,
            `${scope.name}: ${scope.checked ? "on" : "off"} by default${scope.locked ? ", and locked" : ""}`,
            checked === scope.checked && enabled === !scope.locked,
            `checked=${String(checked)} enabled=${String(enabled)}`
          );
        }

        /* --- expiry, and the ceiling --- */

        const expiry = page.getByLabel(PAGE.expiry).first();
        if ((await expiry.count()) > 0) {
          const value = await expiry.inputValue().catch(() => "");
          record(
            label,
            `the expiry defaults to ${DEFAULT_DAYS} days`,
            value.includes(String(DEFAULT_DAYS)),
            `the control reads ${JSON.stringify(value)} — the integrator's decision is ${DEFAULT_DAYS}, ceiling 30`
          );
        } else {
          record(label, "the expiry control is labelled", false, "no control matched an expiry label");
        }

        /* --- choose a project first: Approve is disabled until one is ticked --- */

        const selectAll = page.getByRole("button", { name: /select all current projects/i }).first();
        if ((await selectAll.count()) > 0) {
          await selectAll.click();
        } else {
          const project = page.getByRole("option", { name: /Consent App/i }).first();
          if ((await project.count()) > 0) await project.click().catch(() => {});
          else await page.getByLabel(/Consent App/i).first().check().catch(() => {});
        }

        /* --- keyboard reachability --- */

        const reachable = await tabThrough(page, 60);
        record(
          label,
          "the workspace picker is reachable from the keyboard and labelled",
          reachable.some((name) => PAGE.workspacePicker.test(name)),
          `${reachable.length} tab stops: ${reachable.slice(0, 8).join(" › ")}${reachable.length > 8 ? " …" : ""}`
        );
        record(
          label,
          "so is the project selection",
          reachable.some((name) => PAGE.projectSelect.test(name)),
          "a project multi-select with an accessible name"
        );
        const decisionsReachable =
          reachable.some((name) => PAGE.approve.test(name)) && reachable.some((name) => PAGE.deny.test(name));
        // When the decisions are missing, say what the page actually offers: every
        // button's accessible name and enabled state, plus the tail of the page text,
        // so a red run names the markup instead of a regex.
        const buttonInventory = decisionsReachable
          ? ""
          : await page.evaluate(() =>
              Array.from(document.querySelectorAll("button, [role=button]"))
                .map((el) => {
                  const b = el as HTMLButtonElement;
                  const name = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().replace(/\s+/g, " ");
                  return `${JSON.stringify(name.slice(0, 60))}${b.disabled ? " (disabled)" : ""}`;
                })
                .join(", ")
            );
        const stateTail = decisionsReachable
          ? ""
          : await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(-400));
        record(
          label,
          "and so are Approve and Deny",
          decisionsReachable,
          decisionsReachable
            ? "both decisions are keyboard reachable, not only the one we want you to press"
            : `not both reachable; buttons on the page: [${buttonInventory}]; page tail: ${JSON.stringify(stateTail)}`
        );

        /* --- the layout, at this width --- */

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        record(
          label,
          "the page does not scroll sideways",
          overflow <= 1,
          `${overflow}px of horizontal overflow (UI-5 at 380px, UI-4 above 1190px)`
        );

        /* --- approve, and the terminal comes back to life --- */

        const approveControl = page.getByRole("button", { name: PAGE.approve }).first();
        if ((await approveControl.count()) === 0) {
          // Explain why the role query sees nothing when the DOM has the element.
          const why = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll("button")).find((b) =>
              /^approve/i.test((b.textContent ?? "").trim())
            );
            if (!el) return "no <button> whose text starts with Approve";
            const chain: string[] = [];
            for (let n: Element | null = el; n; n = n.parentElement) {
              const flags = ["aria-hidden", "inert", "hidden", "aria-modal", "role"]
                .filter((a) => n!.hasAttribute(a))
                .map((a) => `${a}=${n!.getAttribute(a)}`);
              if (flags.length) chain.push(`${n.tagName.toLowerCase()}[${flags.join(" ")}]`);
            }
            const style = getComputedStyle(el);
            return `found; ancestors with a11y flags: ${chain.join(" > ") || "none"}; display=${style.display} visibility=${style.visibility} opacity=${style.opacity}; disabled=${(el as HTMLButtonElement).disabled}`;
          });
          const snapshot = await page.locator("main").ariaSnapshot().catch(() => "(no aria snapshot)");
          record(label, "the approve control is exposed to assistive technology", false, `${why}; main aria snapshot tail: ${JSON.stringify(snapshot.slice(-900))}`);
        }
        await approveControl.click();
        const done = await page
          .waitForFunction(
            (pattern: string) => new RegExp(pattern, "i").test(document.body.innerText),
            PAGE.approved.source,
            { timeout: 20_000 }
          )
          .then(() => true)
          .catch(() => false);
        record(label, "Approve confirms, and sends the person back to their terminal", done, "the page says so");

        const issued = await poll(origin, pending.deviceCode, 20_000);
        record(
          label,
          "the terminal's poll completes with a credential",
          issued.status === "issued" && /^za_[A-Za-z0-9_-]{43}$/.test(String(issued.token ?? "")),
          `status ${String(issued.status)}; the browser and the device flow are one transaction`
        );

        /* --- deny, on a link of its own --- */

        const refused = await startLink(origin);
        const denyPage = await context.newPage();
        await denyPage.goto(`${origin}/agent/link?code=${refused.userCode}`, { waitUntil: "domcontentloaded" });
        await denyPage.waitForLoadState("networkidle").catch(() => {});
        await denyPage.getByRole("button", { name: PAGE.deny }).first().click();
        const denied = await poll(origin, refused.deviceCode, 20_000);
        record(
          label,
          "Deny is a real answer and the terminal is told which one",
          JSON.stringify(denied).includes("access_denied"),
          `the poll answered ${JSON.stringify(denied).slice(0, 120)}`
        );
        await denyPage.close();

        record(
          label,
          "the screen logged no console errors",
          consoleErrors.length === 0,
          consoleErrors.length === 0 ? "clean" : consoleErrors.slice(0, 3).join(" | ")
        );
      } catch (err) {
        record(label, "the approval journey ran to the end", false, err instanceof Error ? err.message : String(err));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
    await provider.close();
  }

  const failed = steps.filter((step) => !step.ok);
  const summary = {
    gate: "agent-approval",
    browser: { channel: browserName, engine: "playwright-core chromium" },
    server: { origin, mode: "next dev" },
    identityProvider: { origin: provider.origin, note: "the one double; everything inside src/** is real" },
    workspace: WORKSPACE,
    viewports: viewports.map((one) => `${one.width}x${one.height}`),
    steps,
    passed: steps.length - failed.length,
    failed: failed.length,
    result: failed.length === 0 ? "pass" : "fail",
  };
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

/* --------------------------------- helpers ---------------------------------- */

interface DevServer {
  stop: () => void;
}

/**
 * Start the application the way a developer does, and wait for it to answer.
 *
 * `next dev` rather than a production build: the gate is about the screen, and
 * a build would add minutes to a job for no assertion. The dev server compiles
 * a route on first request, so the readiness check is generous and the first
 * navigation is allowed to be slow.
 */
async function startDevServer(port: number): Promise<DevServer | null> {
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
  );
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) {
      process.stderr.write(`the dev server exited with ${child.exitCode} before it answered:\n${log.join("")}\n`);
      return null;
    }
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok || res.status === 401 || res.status === 503) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      process.stderr.write(`the dev server did not answer within 180s:\n${log.slice(-40).join("")}\n`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(`next dev is answering on http://localhost:${port}\n`);
  return { stop: () => child.kill("SIGKILL") };
}

/** Begin a device flow the way the plugin does: no credential, no cookie. */
async function startLink(origin: string): Promise<{ userCode: string; deviceCode: string }> {
  const res = await fetch(`${origin}/api/agent/link/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: "Claude Code",
      clientVersion: "2.1.4",
      label: "gate-laptop",
      requestedScopes: ["read", "plan", "write", "logs"],
      protocolVersion: 1,
    }),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`POST /api/agent/link/start answered ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { userCode: string; deviceCode: string };
  return { userCode: body.userCode, deviceCode: body.deviceCode };
}

/** Poll the token endpoint the way the plugin does, until it stops saying "pending". */
async function poll(origin: string, deviceCode: string, budgetMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const res = await fetch(`${origin}/api/agent/link/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode, protocolVersion: 1 }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.status !== "authorization_pending" && body.status !== "slow_down") return body;
    if (Date.now() > deadline) return { status: "timed_out" };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Press Tab until focus stops moving, collecting each stop's accessible name.
 *
 * Deliberately not `locator.focus()`: the question is whether a keyboard can
 * *reach* these controls, and a programmatic focus answers a different one.
 */
async function tabThrough(page: import("playwright-core").Page, maxStops: number): Promise<string[]> {
  const names: string[] = [];
  for (let stop = 0; stop < maxStops; stop++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return "";
      const labelled = element.getAttribute("aria-label");
      if (labelled) return labelled;
      const id = element.getAttribute("aria-labelledby");
      if (id) return document.getElementById(id)?.innerText ?? "";
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        const label = element.labels?.[0]?.innerText;
        if (label) return label;
      }
      return (element.innerText || element.getAttribute("title") || element.getAttribute("name") || "").trim();
    });
    if (name) names.push(name.replace(/\s+/g, " ").trim());
  }
  return names;
}

/** The first line of `text` that matches, for a readable transcript. */
function firstMatch(text: string, pattern: RegExp): string {
  const line = text.split("\n").map((one) => one.trim()).find((one) => pattern.test(one));
  return line ? line.slice(0, 120) : `no line matched ${String(pattern)}`;
}

/**
 * A real Supabase session cookie, minted by `@supabase/ssr` itself, as
 * `[name, value]` pairs for `context.addCookies`.
 */
async function sessionCookie(origin: string, token: string): Promise<[string, string][]> {
  const { createServerClient } = await import("@supabase/ssr");
  const jar = new Map<string, string>();
  const client = createServerClient(origin, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: token, refresh_token: "gate-refresh" });
  if (error) throw new Error(`the gate's session could not be established: ${error.message}`);
  if (jar.size === 0) throw new Error("@supabase/ssr wrote no session cookie; the gate has no signed-in browser");
  return [...jar];
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`agent-browser failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
