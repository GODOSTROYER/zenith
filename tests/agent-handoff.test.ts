import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOFF_TASKS, HandoffError, handoffUrl, type HandoffIds, type HandoffTask } from "@/lib/agent-access/control/handoff";

const ORIGIN = "https://tryzenith.cloud";
const APP = join(process.cwd(), "src", "app");

/** Every page under src/app as a route pattern: route groups dropped, `[x]` is one segment. */
function pages(dir = APP, found: { pattern: string[]; dir: string }[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pages(path, found);
    else if (entry === "page.tsx")
      found.push({
        dir,
        pattern: relative(APP, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s)),
      });
  }
  return found;
}
const PAGES = pages();

function pageFor(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  return PAGES.find(
    (p) => p.pattern.length === parts.length && p.pattern.every((s, i) => /^\[.+\]$/.test(s) || s === parts[i])
  );
}

/** Every element id a page directory declares, as JSX `id="x"` or a section table `id: "x"`. */
function anchors(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory() || !/\.tsx?$/.test(entry)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(/\bid(?:="|: ")([a-z][a-z-]*)"/g)) ids.add(m[1]);
  }
  return ids;
}

const FULL: HandoffIds = {
  workspaceId: "ws_1",
  projectId: "prj_1",
  projectSlug: "shop-api",
  environmentId: "env_1",
  deploymentId: "dep_1",
  operationId: "op_1",
  appId: "app_1",
  name: "Acme Labs",
};

describe("handoffUrl", () => {
  it.each(HANDOFF_TASKS.map((t) => [t]))("%s points at an existing page and anchor on the origin", (task: HandoffTask) => {
    const out = handoffUrl(ORIGIN, task, FULL);
    const url = new URL(out.url);
    expect(url.origin).toBe(ORIGIN);
    expect(out.instructions.length).toBeGreaterThan(20);
    const page = pageFor(url.pathname);
    expect(page, `${task} → ${url.pathname} has no page under src/app`).toBeDefined();
    if (url.hash === `#${FULL.operationId}`) {
      // The review screen anchors each proposal card on its operation id.
      expect(readFileSync(join(page!.dir, "integration-control.tsx"), "utf8")).toContain("<span id={op.id} />");
    } else if (url.hash) {
      // /settings has its own page; its sections are the project settings' sections.
      const dir = url.pathname === "/settings" ? join(APP, "(product)", "p", "[slug]", "settings") : page!.dir;
      expect(anchors(dir), `${task} → ${url.hash}`).toContain(url.hash.slice(1));
    }
  });

  it("maps each task to its route", () => {
    const paths = Object.fromEntries(
      HANDOFF_TASKS.map((t) => {
        const u = new URL(handoffUrl(ORIGIN, t, FULL).url);
        return [t, u.pathname + u.search + u.hash];
      })
    );
    expect(paths).toEqual({
      "workspace.create": "/onboarding?step=1",
      "workspace.autonomy": "/p/shop-api/navigator",
      account: "/account#profile",
      "account.export": "/account#data",
      "account.delete": "/account#danger",
      members: "/settings#members",
      invites: "/settings#members",
      "secret.set": "/p/shop-api/settings#secrets",
      "secret.rotate": "/p/shop-api/settings#secrets",
      "connection.credentials": "/p/shop-api/settings#connections",
      "alerts.channel": "/p/shop-api/settings#alerts",
      "environment.policies": "/p/shop-api/settings?env=env_1#environments",
      "environment.delete": "/p/shop-api/settings?env=env_1#environments",
      "project.delete": "/p/shop-api/settings#danger",
      "deploy.approve": "/p/shop-api/deploys?deployment=dep_1",
      "operation.review": "/integrations?operation=op_1#op_1",
      "app.audience": "/apps/app_1#audience",
      relink: "/integrations#linked-agents",
    });
  });

  it("falls back to workspace settings when no project is named", () => {
    expect(handoffUrl(ORIGIN, "secret.set", {}).url).toBe(`${ORIGIN}/settings#secrets`);
    expect(handoffUrl(ORIGIN, "connection.credentials", {}).url).toBe(`${ORIGIN}/settings#connections`);
    expect(handoffUrl(ORIGIN, "operation.review", {}).url).toBe(`${ORIGIN}/integrations#proposals`);
  });

  it("requires the ids a project-specific task cannot do without", () => {
    for (const [task, ids] of [
      ["project.delete", {}],
      ["deploy.approve", { projectSlug: "shop-api" }],
      ["deploy.approve", { deploymentId: "dep_1" }],
      ["app.audience", {}],
      ["workspace.autonomy", {}],
    ] as [HandoffTask, HandoffIds][])
      expect(() => handoffUrl(ORIGIN, task, ids), task).toThrow(HandoffError);
  });

  it("refuses ids that are not identifiers, so nothing can steer the URL", () => {
    for (const ids of [
      { projectSlug: "//evil.example" },
      { projectSlug: "../../x" },
      { projectSlug: "Shop API" },
    ] as HandoffIds[])
      expect(() => handoffUrl(ORIGIN, "project.delete", ids)).toThrow(HandoffError);
    for (const deploymentId of ["x?y=1", "a/b", "a#b", "https://evil.example", "x".repeat(101), ""])
      expect(() => handoffUrl(ORIGIN, "deploy.approve", { projectSlug: "shop-api", deploymentId })).toThrow(HandoffError);
    expect(() => handoffUrl(ORIGIN, "app.audience", { appId: "a%2Fb" })).toThrow(HandoffError);
    expect(() => handoffUrl(ORIGIN, "nope" as HandoffTask, {})).toThrow(HandoffError);
  });

  it("stays on the origin and ignores anything but its origin", () => {
    expect(handoffUrl("https://tryzenith.cloud/some/path?q=1", "account", {}).url).toBe(`${ORIGIN}/account#profile`);
    expect(handoffUrl("http://localhost:3000", "members", {}).url).toBe("http://localhost:3000/settings#members");
    expect(() => handoffUrl("javascript:alert(1)", "account", {})).toThrow(HandoffError);
    expect(() => handoffUrl("not a url", "account", {})).toThrow(HandoffError);
  });

  it("never puts the workspace name or any value in the URL", () => {
    const out = handoffUrl(ORIGIN, "workspace.create", { name: "Acme Labs" });
    expect(out.url).not.toContain("Acme");
    expect(out.command).toBe('zenith login --new-workspace "Acme Labs"');
    for (const task of HANDOFF_TASKS) expect(handoffUrl(ORIGIN, task, FULL).url).not.toMatch(/Acme|ws_1|prj_1/);
  });

  it("keeps a hostile name from breaking out of the command's quotes", () => {
    expect(handoffUrl(ORIGIN, "workspace.create", { name: 'x"; rm -rf ~ `id` $(id)' }).command).toBe(
      'zenith login --new-workspace "x rm -rf id id"'
    );
    expect(handoffUrl(ORIGIN, "workspace.create", { name: '"$`' }).command).toBe("zenith login");
    expect(handoffUrl(ORIGIN, "workspace.create", {}).command).toBe("zenith login");
    expect(handoffUrl(ORIGIN, "relink", {}).command).toBe("zenith login");
  });
});
