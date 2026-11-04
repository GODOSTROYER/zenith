/** Real local Python collector checks. No Azure agent or Linux guest delivery claims. */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AZURE_STDERR_BYTES, AZURE_STDOUT_BYTES, AZURE_WIRE_HEADER, azureScriptPlans } from "@/lib/machines/transports/azure-scripts";
import { buildSsmDocuments } from "@/lib/machines/transports/aws-ssm-docs";
import { azureGuestScript } from "@/lib/machines/transports/azure-scripts";
import { requestFor } from "./_helpers";

const localEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "",
});
const python = (() => {
  const probe = spawnSync("python", ["-I", "-c", "import sys; print(sys.executable)"], { env: localEnv(), encoding: "utf8", timeout: 5000, windowsHide: true });
  return probe.status === 0 ? probe.stdout.trim() : undefined;
})();

function source(script: string): string {
  return script.split("<<'ZENITH_FIXED_PYTHON'\n")[1].replace(/ZENITH_FIXED_PYTHON\n$/, "");
}

function run(code: string, argv: string[] = [], timeoutSec = 5) {
  const plan = azureScriptPlans()(requestFor("machine.exec", { argv: [python!.replace(/\\/g, "/"), "-c", code, ...argv], timeoutSec }));
  const env = { ...localEnv(), ...Object.fromEntries([...plan.parameters, ...plan.protectedParameters].map((p) => [p.name, p.value])), ZENITH_TEST_FORBIDDEN_SECRET: "not-forwarded-canary" };
  const result = spawnSync(python!, ["-I", "-"], { env, input: source(plan.script), encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(4096);
  const stdout = result.stdout.replace(/\r\n/g, "\n");
  expect(stdout.startsWith(AZURE_WIRE_HEADER)).toBe(true);
  const wire = JSON.parse(stdout.slice(AZURE_WIRE_HEADER.length));
  return { ...wire, stdout: Buffer.from(wire.stdout, "base64"), stderr: Buffer.from(wire.stderr, "base64") };
}

describe.skipIf(!python)("Azure fixed Python collector locally", () => {
  it("all semantic and argv collector programs compile", () => {
    const scripts = [...buildSsmDocuments().map((doc) => source(azureGuestScript(doc.document))), source(azureGuestScript())];
    const code = "import json,sys\nfor program in json.load(sys.stdin): compile(program, '<fixed-collector>', 'exec')\n";
    const result = spawnSync(python!, ["-I", "-c", code], { env: localEnv(), input: JSON.stringify(scripts), encoding: "utf8", timeout: 5000, windowsHide: true });
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
  });
  it("metacharacters, quotes and newlines round-trip as argv data without a shell", () => {
    const argv = ["';$(touch sentinel);`whoami`", "line one\nline two", '"quoted"', "{{value}}", "", "é"];
    const result = run("import sys,json; print(json.dumps(sys.argv[1:]))", argv);
    expect(result.exitCode).toBe(0); expect(result.truncated).toBe(false); expect(JSON.parse(result.stdout.toString())).toEqual(argv);
  });
  it("drains large output with bounded memory and a complete sub-4-KiB envelope", () => {
    const result = run('import sys; sys.stdout.write("x" * 20000); sys.stderr.write("y" * 20000)');
    expect(result.exitCode).toBe(0); expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(AZURE_STDOUT_BYTES); expect(result.stderr.length).toBe(AZURE_STDERR_BYTES);
    expect(result.stdout.toString()).toBe("x".repeat(AZURE_STDOUT_BYTES));
  });
  it("child processes receive an explicit environment without collector secrets", () => {
    const result = run('import os; print(os.environ.get("ZENITH_TEST_FORBIDDEN_SECRET", "absent"))');
    expect(result.stdout.toString().trim()).toBe("absent");
  });
  it("preserves the child's actual nonzero exit status", () => {
    expect(run("import sys; sys.exit(42)").exitCode).toBe(42);
  });
  it("terminates a timed-out command and marks its outcome", () => {
    const result = run("import time; time.sleep(10)", [], 1);
    expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0);
  });
});
