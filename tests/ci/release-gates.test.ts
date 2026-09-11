/** Release checks must fail CI when they fail, including image assembly. */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  shell?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  with?: Record<string, unknown>;
}

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  permissions?: unknown;
  env?: Record<string, unknown>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, Job>;
}

// Parse YAML, rather than grepping comments or whitespace. This also rejects
// malformed YAML and duplicate keys before evaluating the release policy.
const workflow = load(
  fs.readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8"),
) as Workflow;

const requiredCommands: Record<string, string[]> = {
  verify: ['"$RUNNER_TEMP/actionlint" .github/workflows/ci.yml', "npm ci", "npm run typecheck", "npm run lint", "npm test", "npm run smoke", "npm run gimbal:verify"],
  build: ["npm ci", "npm run build"],
  docker: ["docker build -t zenith:ci ."],
  hosted: [
    "npm ci",
    "npx vitest run tests/hosted",
    "npx tsx scripts/hosted-acceptance.ts",
    "npx tsx scripts/hosted-browser.ts",
  ],
};

describe("release gate policy", () => {
  it("runs for every pull request and branch push without path filters", () => {
    expect(workflow.on).toEqual({ push: { branches: ["**"] }, pull_request: null });
  });

  it.each(Object.entries(requiredCommands))("keeps %s mandatory and preserves failure exit codes", (name, commands) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"] ?? false).toBe(false);
    for (const command of commands) {
      // Exact standalone commands reject accidental `|| true`, shell wrappers,
      // and commented-out gates. Step conditions must not bypass the command.
      const matches = job.steps.filter((step) => step.run?.trim() === command);
      expect(matches, `${name} must run ${command}`).toHaveLength(1);
      expect(matches[0].if).toBeUndefined();
      expect(matches[0]["continue-on-error"] ?? false).toBe(false);
    }
  });

  it("grants only source read access, with no job escalation or retained checkout token", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("pins every external action to a full immutable commit", () => {
    const actions = Object.values(workflow.jobs).flatMap((job) => job.steps).filter((step) => step.uses);
    expect(actions.length).toBeGreaterThan(0);
    for (const step of actions) {
      expect(step.uses).toMatch(/^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
    }
  });

  it("verifies the pinned validator archive before extracting or executing it", () => {
    const steps = workflow.jobs.verify.steps;
    const installers = steps.filter((step) => step.name === "Install pinned workflow validator");
    expect(installers).toHaveLength(1);
    const installer = installers[0];
    expect(installer.if).toBeUndefined();
    expect(installer["continue-on-error"] ?? false).toBe(false);
    expect(installer.shell).toBe("bash");
    // The install sequence is a supply-chain policy: bounded official download,
    // immutable checksum, fail-fast verification, and extraction of one binary.
    expect(installer.run?.trim().split("\n")).toEqual([
      "set -euo pipefail",
      'cd "$RUNNER_TEMP"',
      "curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 --output actionlint.tar.gz https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
      "printf '%s  %s\\n' '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' 'actionlint.tar.gz' | sha256sum --check --strict",
      'tar -xzf actionlint.tar.gz -C "$RUNNER_TEMP" actionlint',
    ]);
    const syntaxGate = steps.findIndex((step) => step.run === '"$RUNNER_TEMP/actionlint" .github/workflows/ci.yml');
    expect(steps.indexOf(installer)).toBeLessThan(syntaxGate);
  });

  it("isolates CI data using a context that is valid at job scope", () => {
    expect(workflow.jobs.verify.env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci");
  });

  /*
   * The hosted job (W10). It exists because the hosted release gates run real
   * builds and a real browser, which `verify` has no business requiring — and
   * because a hosted gate that is allowed to fail is not a gate.
   */
  describe("the hosted acceptance job", () => {
    const hosted = (): Job => workflow.jobs.hosted;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(hosted(), "the workflow must define a `hosted` job").toBeDefined();
      expect(hosted().if, "the job must not be conditional").toBeUndefined();
      expect(hosted()["continue-on-error"] ?? false).toBe(false);
      for (const step of hosted().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("gets its own data directory, and never the developer's", () => {
      expect(hosted().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-hosted");
      expect(hosted().env?.ZENITH_DATA).not.toBe(workflow.jobs.verify.env?.ZENITH_DATA);
    });

    it("builds for real, because a hosted gate that cannot build proves nothing", () => {
      expect(hosted().env?.ZENITH_BUILD_RUNNER).toBe("recipe-local");
      expect(hosted().env?.ZENITH_RUNTIME).toBe("local");
    });

    it("runs gate 12 with no condition, so a missing browser is a failure and not a skip", () => {
      const step = hosted().steps.find((one) => one.run === "npx tsx scripts/hosted-browser.ts");
      expect(step, "the browser step must be present").toBeDefined();
      expect(step?.if, "and must not be gated on a browser being detected").toBeUndefined();
      expect(step?.["continue-on-error"] ?? false).toBe(false);

      // The detection step is allowed to pass when there is no browser — it is
      // a report, not a gate — but it must not decide whether gate 12 runs.
      const report = hosted().steps.find((one) => one.name === "Report the installed browser");
      expect(report?.run, "the report step names the browsers it looks for").toContain(
        "google-chrome --version"
      );
      expect(report?.run).toContain("microsoft-edge --version");
      expect(
        hosted().steps.some((one) => typeof one.if === "string" && /browser/i.test(one.if)),
        "no step may be conditional on the browser report"
      ).toBe(false);
    });

    it("runs the hosted suites before the journey, and the journey before the browser", () => {
      const order = hosted().steps.map((one) => one.run ?? "");
      const at = (command: string): number => order.findIndex((run) => run.trim() === command);
      expect(at("npx vitest run tests/hosted")).toBeGreaterThan(at("npm ci"));
      expect(at("npx tsx scripts/hosted-acceptance.ts")).toBeGreaterThan(
        at("npx vitest run tests/hosted")
      );
      expect(at("npx tsx scripts/hosted-browser.ts")).toBeGreaterThan(
        at("npx tsx scripts/hosted-acceptance.ts")
      );
    });
  });
});
