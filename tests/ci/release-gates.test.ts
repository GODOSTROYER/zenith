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
  docker: ["docker build -t orrery:ci ."],
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
    expect(workflow.jobs.verify.env?.ORRERY_DATA).toBe("${{ github.workspace }}/.data-ci");
  });
});
