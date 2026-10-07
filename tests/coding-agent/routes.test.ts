/**
 * Reachability and authority of the coding-agent REST surface (PROD-MACH-06):
 * every route exists, is classified browser-only (no agent credential), the
 * routes call the real service, and the adopt route goes through the product
 * action and the broker gate rather than writing anything itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPlatformBearerRequest, platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";

const ROOT = "/api/platform/v1/coding-agent";
const routeFile = (...p: string[]) => readFileSync(path.resolve("src/app/api/platform/v1/coding-agent", ...p, "route.ts"), "utf8");

describe("access classification", () => {
  it.each([
    ["GET", `${ROOT}/runs`],
    ["POST", `${ROOT}/runs`],
    ["GET", `${ROOT}/runs/car_123`],
    ["POST", `${ROOT}/runs/car_123/resume`],
    ["POST", `${ROOT}/runs/car_123/cancel`],
    ["POST", `${ROOT}/runs/car_123/adopt`],
  ])("%s %s is browser-only", (method, pathname) => {
    expect(platformAccess(pathname, method)).toBe("browser-only");
    // a bearer header is never admitted to authentication on these paths
    expect(isPlatformBearerRequest(pathname, method, "Bearer za_whatever")).toBe(false);
  });

  it("classifies nothing else under the prefix", () => {
    expect(platformAccess(`${ROOT}/runs/car_1/approve`, "POST")).toBeUndefined();
    expect(platformAccess(`${ROOT}/runs`, "DELETE")).toBeUndefined();
  });
});

describe("route wiring", () => {
  it("start, resume and cancel only record state and launch/cancel the durable workflow: no agent work in the request", () => {
    const start = routeFile("runs");
    expect(start).toContain("agentAdmin(req)");
    expect(start).toContain("createRun(await codingAgentControl()");
    expect(readFileSync(path.resolve("src/lib/coding-agent/platform.ts"), "utf8")).toContain("modelConfigured: anthropicKeyPresent");
    expect(start).toContain(".strict()");
    const resume = routeFile("runs", "[id]", "resume");
    expect(resume).toContain("resumeRun(await codingAgentControl()");
    expect(resume).toContain("agentAdmin(req)");
    const cancel = routeFile("runs", "[id]", "cancel");
    expect(cancel).toContain("cancelRun(await codingAgentControl()");
    for (const file of [start, resume, cancel]) {
      const code = file.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/runAgent|executeRunStep|anthropic|maxDuration/);
    }
  });

  it("the worker registers the durable workflow's activities and the workflow is exported", () => {
    const worker = readFileSync(path.resolve("workers/execution/worker.ts"), "utf8");
    expect(worker).toContain("createProductionCodingAgentActivities(db)");
    const defs = readFileSync(path.resolve("src/lib/workflows/definitions/index.ts"), "utf8");
    expect(defs).toContain('export { codingAgentRunWorkflow } from "./codingAgent"');
    const workflow = readFileSync(path.resolve("src/lib/workflows/definitions/codingAgent.ts"), "utf8");
    expect(workflow).toContain("heartbeatTimeout");
    expect(workflow).toContain("WAIT_CANCELLATION_COMPLETED");
    expect(workflow).toContain("CancellationScope.nonCancellable");
  });

  it("no route accepts approval, grant or policy members from the body", () => {
    for (const file of [routeFile("runs"), routeFile("runs", "[id]", "resume"), routeFile("runs", "[id]", "adopt")]) {
      const code = file.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/(approved|autonomy|policy|policyVersion|grants?|scopes|approvals?)\s*:/);
    }
  });

  it("adopt goes through the broker operation gate and the existing product action, nothing else", () => {
    const adopt = routeFile("runs", "[id]", "adopt");
    expect(adopt).toContain("assertAdoptable(");
    expect(adopt).toContain("getOperationDetail(");
    expect(adopt).toContain('"project.updateManifest"');
    expect(adopt).not.toMatch(/db\(\)|\.save\(|workingManifest\s*=/);
  });

  it("the admin guard refuses non-admins and verifies the live browser session", () => {
    const guard = readFileSync(path.resolve("src/app/api/platform/v1/_lib/coding-agent.ts"), "utf8");
    expect(guard).toContain("assertBrowserSession(req");
    expect(guard).toContain('role !== "admin"');
    expect(guard).toContain("notFound()");
  });
});

describe("operator page", () => {
  const page = (...p: string[]) => readFileSync(path.resolve("src/app/(product)/platform/coding-agent", ...p), "utf8");

  it("is in the platform navigation and keeps to the existing page conventions", () => {
    const nav = readFileSync(path.resolve("src/app/(product)/platform/_components/platform-nav.tsx"), "utf8");
    expect(nav).toContain('href: "/platform/coding-agent"');
    for (const file of [page("page.tsx"), page("[id]", "page.tsx")]) {
      expect(file).toContain("loadPage(");
      expect(file).toContain("PageState");
      expect(file).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("lists runs and shows budgets, steps, safety report, the plan and a link to the existing approval page", () => {
    const list = page("page.tsx");
    expect(list).toContain("listRuns(");
    expect(list).toContain("<caption");
    const detail = page("[id]", "page.tsx");
    for (const needle of ["Budgets", "Steps and safety report", "Proposed plan", "/platform/operations/", "assertAdoptable(", "<progress"]) expect(detail).toContain(needle);
  });

  it("actions are the browser-only routes, announced politely, with a confirm step for cancel", () => {
    const controls = page("run-controls.tsx");
    for (const verb of ["/resume", "/cancel", "/adopt"]) expect(controls).toContain(verb);
    expect(controls).toContain('credentials: "same-origin"');
    expect(controls).toContain('aria-live="polite"');
    expect(controls).toContain("Confirm cancel");
    expect(controls).toContain('role="group"');
    expect(controls).not.toMatch(/Authorization|Bearer/);
  });
});

