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

interface Service {
  image?: string;
  env?: Record<string, unknown>;
  ports?: unknown;
  options?: string;
}

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  permissions?: unknown;
  env?: Record<string, unknown>;
  services?: Record<string, Service>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, Job>;
}

/** Read and parse one workflow. Rejects malformed YAML and duplicate keys. */
const read = (file: string): Workflow =>
  load(fs.readFileSync(path.join(process.cwd(), ".github/workflows", file), "utf8")) as Workflow;

// Parse YAML, rather than grepping comments or whitespace. This also rejects
// malformed YAML and duplicate keys before evaluating the release policy.
const workflow = read("ci.yml");
const agentControl = read("agent-control.yml");

/**
 * The install line, exactly, in every job that installs.
 *
 * `--ignore-scripts` is a supply-chain decision, not a preference: two packages
 * in this tree declare a `postinstall` (esbuild, unrs-resolver) and both are
 * no-ops once `optionalDependencies` are present, so nothing is bought by
 * letting arbitrary dependency code run at install time. Pinned here because a
 * flag that quietly falls off is indistinguishable from one that was never
 * there.
 */
const INSTALL = "npm ci --ignore-scripts";

/** One Node pin for the whole repository. See the ci.yml header for why this one. */
const NODE_VERSION = "22.16.0";

/** One checkout pin for the whole repository. */
const CHECKOUT = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";

const requiredCommands: Record<string, string[]> = {
  verify: [
    '"$RUNNER_TEMP/actionlint" .github/workflows/ci.yml .github/workflows/tick.yml .github/workflows/agent-control.yml',
    INSTALL,
    "npm run typecheck",
    "npm run lint",
    "npm test",
    "npm run smoke",
    "npm run gimbal:verify",
  ],
  build: [INSTALL, "npm run build"],
  docker: ["docker build -t zenith:ci ."],
  hosted: [
    INSTALL,
    "npx vitest run tests/hosted",
    "npx tsx scripts/hosted-acceptance.ts",
    "npx tsx scripts/hosted-browser.ts",
  ],
  postgres: [
    INSTALL,
    "bash scripts/ci/apply-supabase-migrations.sh",
    "npx vitest run tests/hosted/authority/contract tests/scripts/migrate-hosted-to-postgres.test.ts tests/agent-link/pg-contract.test.ts tests/agent-control/pg-contract.test.ts tests/db/contract/workspace-sharing.test.ts tests/waitlist/pg-contract.test.ts --no-file-parallelism --reporter=default --reporter=json --outputFile.json=.data-ci-lane/postgres-lane.json",
  ],
  agent: [INSTALL, "npm run agent:acceptance", "npm run agent:browser"],
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
    const syntaxGate = steps.findIndex((step) => step.run?.startsWith('"$RUNNER_TEMP/actionlint"'));
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

  /*
   * The linked-agent job.
   *
   * The approval screen is where the user's consent is actually collected, so
   * the browser gate over it gets the same treatment gate 12 gets: no
   * condition, no `continue-on-error`, and a missing browser is a failure
   * rather than a skip. `scripts/agent-browser.ts` exits 2 in that case, which
   * fails the step; nothing in this job may turn that back into a pass.
   */
  describe("the linked-agent job", () => {
    const agent = (): Job => workflow.jobs.agent;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(agent(), "the workflow must define an `agent` job").toBeDefined();
      expect(agent().if).toBeUndefined();
      expect(agent()["continue-on-error"] ?? false).toBe(false);
      for (const step of agent().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("gets its own data directory, and never another job's", () => {
      expect(agent().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-agent");
      for (const other of ["verify", "postgres", "hosted"])
        expect(agent().env?.ZENITH_DATA).not.toBe(workflow.jobs[other].env?.ZENITH_DATA);
    });

    it("runs the journey before the browser, and gates on neither a detected browser nor a flag", () => {
      const order = agent().steps.map((one) => one.run?.trim() ?? "");
      expect(order.indexOf("npm run agent:browser")).toBeGreaterThan(
        order.indexOf("npm run agent:acceptance")
      );
      const browser = agent().steps.find((one) => one.run?.trim() === "npm run agent:browser");
      expect(browser?.if, "the browser gate must not be conditional").toBeUndefined();
      expect(
        agent().steps.some((one) => typeof one.if === "string" && /browser/i.test(one.if)),
        "no step may be conditional on the browser report"
      ).toBe(false);
    });

    it("keeps the two scripts and the npm entry points that name them", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts["agent:acceptance"]).toBe("tsx scripts/agent-acceptance.ts");
      expect(pkg.scripts["agent:browser"]).toBe("tsx scripts/agent-browser.ts");
      for (const file of ["scripts/agent-acceptance.ts", "scripts/agent-browser.ts"])
        expect(fs.existsSync(path.join(process.cwd(), file)), `${file} must exist`).toBe(true);
    });
  });

  /*
   * One Node version and one checkout SHA across the repository.
   *
   * Before this, `ci.yml` floated on `22` while `agent-control.yml` pinned
   * `22.16.0`, and the two pinned different `actions/checkout` commits. The
   * cost of two pins is not the duplication; it is that a merge gate and a
   * release gate could disagree about what "green" was measured on.
   */
  describe("the toolchain pins", () => {
    const nodeSteps = (w: Workflow): Step[] =>
      Object.values(w.jobs)
        .flatMap((job) => job.steps)
        .filter((step) => step.uses?.startsWith("actions/setup-node@"));

    it("pins one exact Node version in every job that sets one up", () => {
      const steps = [...nodeSteps(workflow), ...nodeSteps(agentControl)];
      // Four in ci.yml (verify, postgres, hosted, build) plus agent-control.
      expect(steps.length).toBeGreaterThanOrEqual(5);
      for (const step of steps) expect(String(step.with?.["node-version"])).toBe(NODE_VERSION);
    });

    it("pins one checkout commit in every workflow that checks out", () => {
      const checkouts = [...Object.values(workflow.jobs), ...Object.values(agentControl.jobs)]
        .flatMap((job) => job.steps)
        .filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts.length).toBeGreaterThanOrEqual(5);
      for (const step of checkouts) {
        expect(step.uses).toBe(CHECKOUT);
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    });

    it("installs with --ignore-scripts everywhere, and never with a bare npm ci", () => {
      const installs = [...Object.values(workflow.jobs), ...Object.values(agentControl.jobs)]
        .flatMap((job) => job.steps)
        .map((step) => step.run?.trim() ?? "")
        .filter((run) => run.startsWith("npm ci"));
      expect(installs.length).toBeGreaterThanOrEqual(5);
      for (const run of installs) expect(run).toBe(INSTALL);
    });
  });

  /*
   * The PostgreSQL job (F1).
   *
   * It exists because every live contract lane in this repository is gated on
   * `ZENITH_CONTRACT_POSTGRES` and, unset, disappears without a trace: the
   * hosted-authority suites are `describe.each` over a factory table whose
   * Postgres row is simply absent (`tests/hosted/authority/contract/_factories.ts:152`).
   * A green run that exercised no Postgres looked exactly like one that did.
   *
   * These assertions pin the parts that make the job mean something: a real
   * database, both gating variables, the migrations actually applied, and a
   * report step that fails when a lane produced zero tests.
   */
  describe("the PostgreSQL contract job", () => {
    const pg = (): Job => workflow.jobs.postgres;

    it("runs unconditionally, and its failure fails CI", () => {
      expect(pg(), "the workflow must define a `postgres` job").toBeDefined();
      expect(pg().if).toBeUndefined();
      expect(pg()["continue-on-error"] ?? false).toBe(false);
      for (const step of pg().steps)
        expect(
          step["continue-on-error"] ?? false,
          `step ${step.name ?? step.run ?? step.uses} must not continue on error`
        ).toBe(false);
    });

    it("brings a real PostgreSQL service container, pinned by digest", () => {
      const service = pg().services?.postgres;
      expect(service, "the job must declare a `postgres` service").toBeDefined();
      // A tag alone would let the database move underneath the assertions.
      expect(service?.image).toMatch(/^postgres:[\w.-]+@sha256:[a-f0-9]{64}$/);
      expect(service?.options, "the job must wait on a health check").toContain("pg_isready");
      expect(service?.ports).toEqual(["5432:5432"]);
    });

    it("sets both conditions the contract factories require, or the lane is not in the table", () => {
      // tests/hosted/authority/contract/_factories.ts:79-80 — the flag says you
      // meant it, the URL says there is something to mean it about.
      expect(pg().env?.ZENITH_CONTRACT_POSTGRES).toBe("1");
      expect(String(pg().env?.SUPABASE_DB_URL)).toMatch(/^postgresql:\/\/.+@127\.0\.0\.1:5432\//);
      // Setting this to `postgres` would make both factory rows the same
      // database and quietly delete the SQLite half of the contract.
      expect(pg().env?.ZENITH_HOSTED_STORE).toBeUndefined();
    });

    it("gets its own data directory, and never another job's", () => {
      expect(pg().env?.ZENITH_DATA).toBe("${{ github.workspace }}/.data-ci-postgres");
      expect(pg().env?.ZENITH_DATA).not.toBe(workflow.jobs.verify.env?.ZENITH_DATA);
      expect(pg().env?.ZENITH_DATA).not.toBe(workflow.jobs.hosted.env?.ZENITH_DATA);
    });

    it("applies the migrations before it runs anything against them", () => {
      const order = pg().steps.map((step) => step.run?.trim() ?? "");
      const at = (command: string): number => order.indexOf(command);
      expect(at("bash scripts/ci/apply-supabase-migrations.sh")).toBeGreaterThan(at(INSTALL));
      expect(order.findIndex((run) => run.startsWith("npx vitest run"))).toBeGreaterThan(
        at("bash scripts/ci/apply-supabase-migrations.sh")
      );
    });

    it("includes every committed migration in order in the database bootstrap", () => {
      const script = fs.readFileSync(path.join(process.cwd(), "scripts/ci/apply-supabase-migrations.sh"), "utf8");
      const manifest = script.match(/^MIGRATIONS=\(\r?\n([\s\S]*?)^\)/m)?.[1];
      expect(manifest, "the apply script must declare its ordered migration manifest").toBeDefined();
      const applied = [...(manifest ?? "").matchAll(/"([^"\n]+\.sql)"/g)].map((match) => match[1]);
      const committed = fs.readdirSync(path.join(process.cwd(), "supabase/migrations"))
        .filter((file) => file.endsWith(".sql")).sort();
      expect(applied).toEqual(committed);
    });

    it("reports on the lanes even when the suites failed, and fails when one ran nothing", () => {
      const report = pg().steps.find((step) =>
        step.run?.includes("scripts/ci/postgres-lane-report.mjs")
      );
      expect(report, "the job must end in a lane report").toBeDefined();
      // `always()` so a blocked-lane table still reaches the job summary after a
      // red suite — the one condition in this workflow that is deliberate.
      expect(report?.if).toBe("always()");
      expect(report?.["continue-on-error"] ?? false).toBe(false);
      expect(report?.run?.trim()).toBe("node scripts/ci/postgres-lane-report.mjs .data-ci-lane/postgres-lane.json");
    });

    it("keeps the helper scripts it depends on", () => {
      for (const file of [
        "scripts/ci/apply-supabase-migrations.sh",
        "scripts/ci/postgres-lane-report.mjs",
      ])
        expect(fs.existsSync(path.join(process.cwd(), file)), `${file} must exist`).toBe(true);
    });
  });

  /*
   * actionlint validates every workflow, not only the one it lives in.
   * `tick.yml` drives production background work on a schedule and
   * `agent-control.yml` is a merge gate; neither was being parsed by anything.
   */
  it("validates every workflow file in the repository", () => {
    const step = workflow.jobs.verify.steps.find((one) => one.name === "Validate workflow syntax");
    expect(step).toBeDefined();
    const onDisk = fs
      .readdirSync(path.join(process.cwd(), ".github/workflows"))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    for (const name of onDisk)
      expect(step?.run, `actionlint must be given .github/workflows/${name}`).toContain(
        `.github/workflows/${name}`
      );
  });
});
