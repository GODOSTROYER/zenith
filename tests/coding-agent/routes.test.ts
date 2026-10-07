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
  it("start and resume call the real service with the admin browser caller and the production deps", () => {
    const start = routeFile("runs");
    expect(start).toContain("agentAdmin(req)");
    expect(start).toContain("startRun(await codingAgentDeps()");
    expect(start).toContain(".strict()");
    const resume = routeFile("runs", "[id]", "resume");
    expect(resume).toContain("resumeRun(await codingAgentDeps()");
    expect(resume).toContain("agentAdmin(req)");
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
