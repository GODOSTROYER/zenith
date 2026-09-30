/**
 * The Zenith SSM documents are the code that actually runs as root on
 * customer machines, so they get the strictest tests in this module:
 *   - static: every parameter is typed and pattern-constrained; parameters
 *     reach scripts only as quoted environment variables; no eval;
 *   - consistency: the JSON files equal what the TypeScript generator builds
 *     from the shared limits (prefix allowlist, deny list, protected units);
 *   - tofu: the compiled `aws_ssm_document` content survives OpenTofu's HCL
 *     template evaluation byte for byte (`${…}` escaping);
 *   - behavioural (when a POSIX `sh` is available; here through WSL): the
 *     scripts themselves, run against hostile parameters.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_READ_PREFIXES, FILE_READ_DENY_GLOBS, isProtectedUnit } from "@/lib/machines";
import {
  buildSsmDocuments,
  checkDocumentParameters,
  documentNameFor,
  escapeHclTemplate,
  filePathPattern,
  OPERATION_DOCUMENTS,
  specializeFileRead,
  specializeServiceRestart,
  ssmDocumentsTofu,
  ZENITH_SSM_DOCUMENT_SUFFIXES,
  ZENITH_SSM_DOCUMENTS,
  type SsmCommandDocument,
} from "@/lib/machines/transports/aws-ssm-docs";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { findSh, q } from "./_sh";

const DOC_DIR = path.resolve(__dirname, "../../deploy/aws/ssm-documents");
const docs = Object.entries(ZENITH_SSM_DOCUMENTS) as [keyof typeof ZENITH_SSM_DOCUMENTS, SsmCommandDocument][];
const script = (d: SsmCommandDocument): string[] => d.mainSteps[0].inputs.runCommand;

/* ------------------------------ static structure ------------------------------ */

describe("document files", () => {
  it("there is exactly one JSON file per document suffix, named Zenith-<suffix>.json", () => {
    expect(readdirSync(DOC_DIR).sort()).toEqual(ZENITH_SSM_DOCUMENT_SUFFIXES.map((s) => `Zenith-${s}.json`).sort());
  });

  it("every operation that uses a document maps to an existing one", () => {
    for (const suffix of Object.values(OPERATION_DOCUMENTS)) expect(ZENITH_SSM_DOCUMENTS[suffix]).toBeDefined();
  });

  it.each(docs)("%s: schema 2.2, one Linux-only runShellScript step with a parameterized timeout", (_suffix, d) => {
    expect(d.schemaVersion).toBe("2.2");
    expect(d.mainSteps).toHaveLength(1);
    const step = d.mainSteps[0];
    expect(step.action).toBe("aws:runShellScript");
    expect(step.precondition).toEqual({ StringEquals: ["platformType", "Linux"] });
    expect(step.inputs.timeoutSeconds).toBe("{{ executionTimeout }}");
    expect(d.parameters.executionTimeout).toBeDefined();
  });
});

describe("every parameter is typed and pattern-constrained", () => {
  it.each(docs)("%s", (_suffix, d) => {
    for (const [name, p] of Object.entries(d.parameters)) {
      expect(p.type, `${name}.type`).toBe("String");
      expect(typeof p.allowedPattern, `${name}.allowedPattern`).toBe("string");
      expect(p.allowedPattern.startsWith("^") && p.allowedPattern.endsWith("$"), `${name} is anchored`).toBe(true);
      expect(() => new RegExp(p.allowedPattern), `${name} compiles`).not.toThrow();
      // SSM validates in Java regex AND in Go RE2 on the agent: no lookaround, backreferences, named groups
      expect(p.allowedPattern, `${name} is RE2-compatible`).not.toMatch(/\(\?|\\[1-9]|\\p\{|\\k</);
      expect(Number.isInteger(p.maxChars) && p.maxChars > 0, `${name}.maxChars`).toBe(true);
      // a default must satisfy its own pattern, or SSM refuses to start the document
      if (p.default !== undefined) expect(new RegExp(p.allowedPattern).test(p.default), `${name} default matches`).toBe(true);
      // everything a script reads is delivered as an environment variable, never pasted into script text
      if (name !== "executionTimeout") expect(p.interpolationType, `${name}.interpolationType`).toBe("ENV_VAR");
    }
  });

  const HOSTILE = ["a;b", "a$(id)", "a`id`", "a\nb", "a'b", 'a"b', "a b", "a|b", "a&b", "a>b", "a<b", "a\\b", "{{x}}", "$x", "a*b", "a\0b", "a\tb", "${x}", "a#b", "a!b"];
  it.each(docs)("%s: no hostile character is accepted by any parameter pattern", (_suffix, d) => {
    for (const [name, p] of Object.entries(d.parameters)) {
      const re = new RegExp(p.allowedPattern);
      for (const h of HOSTILE) {
        expect(re.test(h), `${name} must refuse ${JSON.stringify(h)}`).toBe(false);
        expect(re.test(`/var/log/${h}`), `${name} must refuse embedded ${JSON.stringify(h)}`).toBe(false);
        expect(re.test(`nginx${h}.service`), `${name} must refuse embedded ${JSON.stringify(h)}`).toBe(false);
      }
    }
  });
});

/* ------------------------- how scripts use parameters ------------------------- */

type Ref = { name: string; quoted: boolean };

/**
 * A small shell lexer: finds `$name` / `${name…}` references and whether each
 * sits inside double quotes. Understands single quotes, backslashes and
 * `$( … )` nesting, which is everything the Zenith scripts use.
 */
function references(line: string): Ref[] {
  const out: Ref[] = [];
  type Frame = "none" | "single" | "double" | "cmd";
  const stack: { kind: Frame; depth: number }[] = [{ kind: "none", depth: 0 }];
  const top = () => stack[stack.length - 1];
  const quoted = () => top().kind === "double";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const t = top();
    if (t.kind === "single") {
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$") {
      const rest = line.slice(i + 1);
      const m = /^\{?#?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (m) out.push({ name: m[1], quoted: quoted() });
      if (rest.startsWith("(") && !rest.startsWith("((")) {
        stack.push({ kind: "cmd", depth: 1 });
        i++;
      }
      continue;
    }
    if (t.kind === "double") {
      if (c === '"') stack.pop();
      continue;
    }
    // none or cmd
    if (c === "'") stack.push({ kind: "single", depth: 0 });
    else if (c === '"') stack.push({ kind: "double", depth: 0 });
    else if (t.kind === "cmd") {
      if (c === "(") t.depth++;
      else if (c === ")" && --t.depth === 0) stack.pop();
    }
  }
  return out;
}

describe("shell reference lexer (self-check)", () => {
  it("tells quoted from unquoted references", () => {
    expect(references('x="$unit"')).toEqual([{ name: "unit", quoted: true }]);
    expect(references("echo $unit")).toEqual([{ name: "unit", quoted: false }]);
    expect(references("echo '$unit'")).toEqual([]);
    expect(references('echo "$(printf %s "$unit" | head -c 3)"')).toEqual([{ name: "unit", quoted: true }]);
    expect(references('echo "$(printf %s $unit)"')).toEqual([{ name: "unit", quoted: false }]);
    expect(references('n="${#unit}"')).toEqual([{ name: "unit", quoted: true }]);
    expect(references('case "$unit" in *) ;; esac')).toEqual([{ name: "unit", quoted: true }]);
  });
});

describe("scripts only use parameters as quoted values", () => {
  it.each(docs)("%s", (_suffix, d) => {
    const lines = script(d);
    const text = lines.join("\n");
    const params = Object.keys(d.parameters).filter((n) => n !== "executionTimeout");

    // no text interpolation anywhere in script text (ENV_VAR only)
    expect(text, "no {{ }} in script text").not.toMatch(/\{\{|\}\}/);
    // never eval, never command substitution by backticks, never a shell built from data
    expect(text).not.toMatch(/\beval\b/);
    expect(text).not.toContain("`");
    expect(text).not.toMatch(/\b(?:ba)?sh\s+-c\s+["$]/);
    expect(text).not.toMatch(/\bsource\b|(^|[;&|]\s*)\.\s+\S/m);

    // each parameter is read exactly once, straight into a double-quoted shell variable
    const assigned: Record<string, string> = {};
    for (const line of lines) {
      const all = [...line.matchAll(/SSM_([A-Za-z0-9]+)/g)].map((m) => m[1]);
      if (all.length === 0) continue;
      const m = /^([a-z]+)="\$\{SSM_([A-Za-z0-9]+)-\}"$/.exec(line);
      expect(m, `SSM_ is only referenced in a plain assignment, found: ${line}`).not.toBeNull();
      assigned[m![2]] = m![1];
    }
    expect(Object.keys(assigned).sort(), "every parameter is read").toEqual([...params].sort());

    // and every later use of those variables is inside double quotes
    const vars = new Set(Object.values(assigned));
    for (const line of lines) {
      for (const r of references(line)) {
        if (vars.has(r.name)) expect(r.quoted, `${r.name} must be quoted in: ${line}`).toBe(true);
      }
    }
  });

  it.each(docs)("%s: pins PATH, disables globbing, validates before acting", (_suffix, d) => {
    const lines = script(d);
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines).toContain("set -u");
    expect(lines).toContain("set -f");
    expect(lines.some((l) => l.startsWith("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("exit 0");
  });

  it("the only bash -c in any document is a fixed single-quoted probe fed by positional arguments", () => {
    const hits = docs.flatMap(([, d]) => script(d).filter((l) => /\bbash\s+-c\b/.test(l)));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$a" "$port"`);
  });
});

/* ------------------------ consistency with the generator ------------------------ */

describe("JSON files match the TypeScript single sources of truth", () => {
  it("FileRead: default prefixes, pattern and script allowlist agree with DEFAULT_FILE_READ_PREFIXES", () => {
    const d = ZENITH_SSM_DOCUMENTS.FileRead;
    expect(d.parameters.path.allowedPattern).toBe(filePathPattern(DEFAULT_FILE_READ_PREFIXES));
    expect(script(d)).toContain(`allow='${DEFAULT_FILE_READ_PREFIXES.join(" ")}'`);
    expect(specializeFileRead(d, DEFAULT_FILE_READ_PREFIXES)).toEqual(d);
  });

  it("FileRead: the script's deny patterns are exactly FILE_READ_DENY_GLOBS", () => {
    const line = script(ZENITH_SSM_DOCUMENTS.FileRead).find((l) => l.startsWith("deny()"))!;
    const pats = /case "\$l" in (.*)\) return 0/.exec(line)![1].split("|");
    expect(pats).toEqual([...FILE_READ_DENY_GLOBS]);
  });

  it("ServiceRestart: the script's protected units agree with isProtectedUnit", () => {
    const line = script(ZENITH_SSM_DOCUMENTS.ServiceRestart).find((l) => l.startsWith('case "$unit" in ssh.service'))!;
    const pats = /in (.*)\) die 65/.exec(line)![1].split("|");
    const matches = (unit: string) => pats.some((p) => new RegExp(`^${p.replace(/[.+]/g, "\\$&").replace(/\*/g, ".*")}$`).test(unit));
    for (const unit of [
      "ssh.service", "sshd.service", "ssh.socket", "sshd.socket", "ssh@1.service", "systemd-journald.service", "systemd-resolved.service",
      "dbus.service", "dbus.socket", "dbus-broker.service", "amazon-ssm-agent.service", "snap.amazon-ssm-agent.amazon-ssm-agent.service",
      "zenithd.service", "zenith-runner.service", "nginx.service", "docker.service", "cron.service", "myssh.service",
    ]) {
      expect(matches(unit), unit).toBe(isProtectedUnit(unit));
    }
  });

  it("the SSM output size limit leaves room: file.read is capped well below 24,000 characters of base64", () => {
    const cap = 16384;
    expect(Math.ceil(cap / 3) * 4 + 400).toBeLessThan(24000);
    expect(script(ZENITH_SSM_DOCUMENTS.FileRead).join("\n")).toContain("[ \"$maxb\" -le 16384 ] || maxb=16384");
  });
});

describe("specialization", () => {
  const file = ZENITH_SSM_DOCUMENTS.FileRead;
  it("FileRead takes an environment allowlist in both the parameter pattern and the script", () => {
    const d = specializeFileRead(file, ["/var/log/app/", "/etc/app.conf"]);
    const re = new RegExp(d.parameters.path.allowedPattern);
    expect(re.test("/var/log/app/x.log")).toBe(true);
    expect(re.test("/etc/app.conf")).toBe(true);
    expect(re.test("/var/log/other/x.log")).toBe(false);
    expect(re.test("/etc/app.conf.bak")).toBe(false);
    expect(re.test("/etc/passwd")).toBe(false);
    expect(script(d)).toContain("allow='/var/log/app/ /etc/app.conf'");
    // the shipped document is not mutated
    expect(file.parameters.path.allowedPattern).toBe(filePathPattern(DEFAULT_FILE_READ_PREFIXES));
  });
  it.each([[[]], [["/"]], [["var/log/"]], [["/var/../etc/"]], [["/var/log/a b/"]], [["/var/log;x/"]], [["/var//log/"]]])("FileRead refuses the prefix list %j", (prefixes) => {
    expect(() => specializeFileRead(file, prefixes)).toThrow();
  });
  it("ServiceRestart can be limited to an explicit unit list, and never includes protected units", () => {
    const d = specializeServiceRestart(ZENITH_SSM_DOCUMENTS.ServiceRestart, ["nginx.service", "app@1.service"]);
    const re = new RegExp(d.parameters.unit.allowedPattern);
    expect(re.test("nginx.service")).toBe(true);
    expect(re.test("app@1.service")).toBe(true);
    expect(re.test("postgresql.service")).toBe(false);
    expect(re.test("nginxXservice")).toBe(false);
    expect(script(d)).toContain("allow='nginx.service app@1.service'");
    expect(() => specializeServiceRestart(ZENITH_SSM_DOCUMENTS.ServiceRestart, ["sshd.service"])).toThrow(/protected/);
    expect(() => specializeServiceRestart(ZENITH_SSM_DOCUMENTS.ServiceRestart, ["x;id.service"])).toThrow();
  });
  it("buildSsmDocuments applies prefix, file and restart options", () => {
    const built = buildSsmDocuments({ namePrefix: "Acme-", fileReadPrefixes: ["/srv/app/"], restartAllow: ["web.service"] });
    expect(built.map((b) => b.name)).toEqual(ZENITH_SSM_DOCUMENT_SUFFIXES.map((s) => `Acme-${s}`));
    expect(built.find((b) => b.suffix === "FileRead")!.document.parameters.path.allowedPattern).toContain("/srv/app/");
    expect(built.find((b) => b.suffix === "ServiceRestart")!.document.parameters.unit.allowedPattern).toBe("^(web\\.service)$");
    expect(documentNameFor("FileRead")).toBe("Zenith-FileRead");
  });
});

describe("checkDocumentParameters", () => {
  const d = ZENITH_SSM_DOCUMENTS.ServiceStatus;
  it("accepts conforming values and reports rules (never values) otherwise", () => {
    expect(checkDocumentParameters(d, { unit: "nginx.service", executionTimeout: "30" })).toEqual([]);
    expect(checkDocumentParameters(d, { unit: "nginx.service; id" }).join(" ")).toMatch(/unit: does not match/);
    expect(checkDocumentParameters(d, { unit: "nginx.service; id" }).join(" ")).not.toContain("id");
    expect(checkDocumentParameters(d, {})).toEqual(["unit: required"]);
    expect(checkDocumentParameters(d, { unit: "a.service", extra: "x" })).toEqual(["extra: not a parameter of the document"]);
    expect(checkDocumentParameters(d, { unit: "a".repeat(200) + ".service" }).join(" ")).toMatch(/longer than/);
  });
});

/* ---------------------------------- OpenTofu ---------------------------------- */

describe("ssmDocumentsTofu", () => {
  it("emits one aws_ssm_document per document, deterministically, with tags and stable labels", () => {
    const a = ssmDocumentsTofu({ tags: { "zenith:managed": "true" } });
    const b = ssmDocumentsTofu({ tags: { "zenith:managed": "true" } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const resources = a.resource!.aws_ssm_document;
    expect(Object.keys(resources)).toEqual([
      "zenith_ssm_machine_inspect", "zenith_ssm_process_list", "zenith_ssm_service_status", "zenith_ssm_service_restart",
      "zenith_ssm_container_list", "zenith_ssm_container_inspect", "zenith_ssm_container_logs", "zenith_ssm_file_read",
      "zenith_ssm_port_check", "zenith_ssm_dns_check", "zenith_ssm_system_metrics", "zenith_ssm_system_logs",
    ]);
    expect(a.addresses).toEqual(Object.keys(resources).map((k) => `aws_ssm_document.${k}`));
    for (const r of Object.values(resources)) {
      expect(r).toMatchObject({ document_type: "Command", document_format: "JSON", target_type: "/AWS::EC2::Instance", tags: { "zenith:managed": "true" } });
    }
    expect(resources.zenith_ssm_file_read.name).toBe("Zenith-FileRead");
  });

  it("escapes HCL template sequences so shell ${VAR} is not interpolated by OpenTofu", () => {
    expect(escapeHclTemplate("a ${x} b %{if} c")).toBe("a $${x} b %%{if} c");
    const content = ssmDocumentsTofu().resource!.aws_ssm_document.zenith_ssm_service_status.content as string;
    expect(content).toContain("$${SSM_unit-}");
    expect(content.replace(/\$\$\{/g, "${").replace(/%%\{/g, "%{")).toBe(buildSsmDocuments().find((b) => b.suffix === "ServiceStatus")!.content);
    expect(() => JSON.parse(content.replace(/\$\$\{/g, "${"))).not.toThrow();
  });

  const haveTofu = (() => {
    try {
      return spawnSync(resolveTofuBinary(), ["version"], { stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!haveTofu)("survives OpenTofu HCL template evaluation byte for byte (real tofu, builtin provider only)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "zenith-ssm-tofu-"));
    try {
      const fragment = ssmDocumentsTofu();
      const locals: Record<string, string> = {};
      const outputs: Record<string, { value: string }> = {};
      for (const [label, res] of Object.entries(fragment.resource!.aws_ssm_document)) {
        locals[label] = res.content as string; // already escaped by the compiler
        outputs[label] = { value: `\${local.${label}}` };
      }
      writeFileSync(path.join(tmp, "main.tf.json"), JSON.stringify({ locals, output: outputs }));
      const bin = resolveTofuBinary();
      const env = { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1", TF_DATA_DIR: path.join(tmp, ".data") };
      const run = (args: string[]) => spawnSync(bin, args, { cwd: tmp, env, encoding: "utf8" });
      expect(run(["init", "-input=false", "-no-color"]).status).toBe(0);
      const applied = run(["apply", "-auto-approve", "-input=false", "-no-color"]);
      expect(applied.status, applied.stdout + applied.stderr).toBe(0);
      const out = JSON.parse(run(["output", "-json"]).stdout) as Record<string, { value: string }>;
      for (const b of buildSsmDocuments()) {
        const label = Object.keys(fragment.resource!.aws_ssm_document).find((k) => fragment.resource!.aws_ssm_document[k].name === b.name)!;
        expect(out[label].value, b.name).toBe(b.content);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 120_000);

  it("the shipped JSON files equal what the generator builds (no drift)", () => {
    for (const b of buildSsmDocuments()) {
      const onDisk = JSON.parse(readFileSync(path.join(DOC_DIR, `Zenith-${b.suffix}.json`), "utf8"));
      expect(onDisk).toEqual(b.document);
    }
  });
});

/* ----------------------------- behaviour of the scripts ----------------------------- */

const sh = findSh();

/** run a document's script with the given parameter environment; returns the script's own exit status */
function runDoc(suffix: keyof typeof ZENITH_SSM_DOCUMENTS, env: Record<string, string>, doc = ZENITH_SSM_DOCUMENTS[suffix], before = "") {
  const vars = Object.entries(env)
    .map(([k, v]) => `${k}=${q(v)}`)
    .join(" ");
  return sh!(`${before}\nenv -i ${vars} sh "$T/doc.sh"`, { "doc.sh": script(doc).join("\n") });
}

/** run one document against many parameter sets in a single shell (WSL start-up dominates otherwise) */
function runDocs(suffix: keyof typeof ZENITH_SSM_DOCUMENTS, envs: Record<string, string>[], doc = ZENITH_SSM_DOCUMENTS[suffix], before = "") {
  const steps = envs.map((env, i) => {
    const vars = Object.entries(env)
      .map(([k, v]) => `${k}=${q(v)}`)
      .join(" ");
    return `env -i ${vars} sh "$T/doc.sh" >"$T/out.${i}" 2>"$T/err.${i}"; rc=$?; printf '\n@@ZCASE ${i} %s\n' "$rc"; cat "$T/out.${i}"; printf '\n@@ZERR\n'; cat "$T/err.${i}"`;
  });
  const r = sh!(`${before}\n${steps.join("\n")}`, { "doc.sh": script(doc).join("\n") });
  const cases = r.stdout
    .split("\n@@ZCASE ")
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const [out, err] = chunk.slice(nl + 1).split("\n@@ZERR\n");
      return { status: Number(chunk.slice(0, nl).split(" ")[1]), stdout: out ?? "", stderr: err ?? "" };
    });
  expect(cases, r.stderr).toHaveLength(envs.length);
  return cases;
}
const statuses = (suffix: keyof typeof ZENITH_SSM_DOCUMENTS, envs: Record<string, string>[], doc?: SsmCommandDocument) => runDocs(suffix, envs, doc).map((c) => c.status);

describe.skipIf(!sh)("script behaviour: input validation (runs the real scripts under sh)", () => {
  it("refuses hostile units with exit 64 before touching systemctl", () => {
    const units = ["x;id.service", "$(id).service", "`id`.service", "a b.service", "-x.service", "--help.service", "nginx", "a\nb.service", "", "a'b.service"];
    for (const suffix of ["ServiceStatus", "ServiceRestart"] as const) {
      const r = runDocs(suffix, units.map((u) => ({ SSM_unit: u })));
      r.forEach((c, i) => {
        expect(c.status, `${suffix} ${JSON.stringify(units[i])}: ${c.stderr}`).toBe(64);
        expect(c.stdout).toBe("");
      });
    }
  });

  it("refuses to restart protected units with exit 65", () => {
    const units = ["sshd.service", "ssh.service", "systemd-journald.service", "dbus.service", "amazon-ssm-agent.service", "snap.amazon-ssm-agent.amazon-ssm-agent.service", "zenithd.service"];
    runDocs("ServiceRestart", units.map((u) => ({ SSM_unit: u }))).forEach((c, i) => {
      expect(c.status, `${units[i]}: ${c.stderr}`).toBe(65);
      expect(c.stderr).toContain("protected");
    });
  });

  it("enforces a restart allowlist baked into the document", () => {
    const d = specializeServiceRestart(ZENITH_SSM_DOCUMENTS.ServiceRestart, ["nginx.service"]);
    const [c] = runDocs("ServiceRestart", [{ SSM_unit: "postgresql.service" }], d);
    expect(c.status, c.stderr).toBe(65);
    expect(c.stderr).toContain("allowlist");
  });

  it("an agent too old for ENV_VAR (empty variables) fails closed, naming the cause", () => {
    const [c] = runDocs("ServiceStatus", [{}]);
    expect(c.status).toBe(64);
    expect(c.stderr).toMatch(/3\.3\.2746\.0/);
    expect(statuses("FileRead", [{}])).toEqual([64]);
    expect(statuses("PortCheck", [{}])).toEqual([64]);
  });

  it("validates numeric, enum and boolean parameters", () => {
    expect(
      statuses("ProcessList", [
        { SSM_limit: "0", SSM_sortBy: "cpu" },
        { SSM_limit: "501", SSM_sortBy: "cpu" },
        { SSM_limit: "5;id", SSM_sortBy: "cpu" },
        { SSM_limit: "5", SSM_sortBy: "pid" },
      ])
    ).toEqual([64, 64, 64, 64]);
    expect(statuses("ContainerList", [{ SSM_all: "yes", SSM_limit: "5" }, { SSM_all: "true", SSM_limit: "201" }])).toEqual([64, 64]);
    const evil = ["a b", "-rf", "--help", "a;b", "$(id)", "a/b", "", "a`b`"];
    expect(statuses("ContainerInspect", evil.map((c) => ({ SSM_container: c })))).toEqual(evil.map(() => 64));
    const logs = { SSM_container: "web", SSM_since: "", SSM_lines: "5", SSM_timestamps: "false" };
    expect(statuses("ContainerLogs", evil.map((c) => ({ ...logs, SSM_container: c })))).toEqual(evil.map(() => 64));
    expect(
      statuses("ContainerLogs", [
        { ...logs, SSM_since: "10x" },
        { ...logs, SSM_since: "5m;id" },
        { ...logs, SSM_lines: "5001" },
        { ...logs, SSM_timestamps: "maybe" },
      ])
    ).toEqual([64, 64, 64, 64]);
    expect(
      statuses("SystemLogs", [
        { SSM_unit: "", SSM_since: "8d", SSM_lines: "5" },
        { SSM_unit: "x;id.service", SSM_since: "1h", SSM_lines: "5" },
        { SSM_unit: "", SSM_since: "1h", SSM_lines: "0" },
        { SSM_unit: "", SSM_since: "", SSM_lines: "5" },
      ])
    ).toEqual([64, 64, 64, 64]);
  });

  it("refuses metadata names and malformed hosts in PortCheck and DnsCheck (exit 64/65, before any network tool)", () => {
    const port = { SSM_port: "80", SSM_timeoutSec: "2" };
    const meta = ["metadata.google.internal", "METADATA.GOOGLE.INTERNAL.", "metadata", "instance-data", "x.metadata.google.internal", "metadata.goog"];
    expect(statuses("PortCheck", meta.map((h) => ({ ...port, SSM_host: h })))).toEqual(meta.map(() => 65));
    expect(statuses("DnsCheck", meta.map((h) => ({ SSM_name: h, SSM_recordType: "A" })))).toEqual(meta.map(() => 65));
    const malformed = ["a;b", "a b", "$(id)", "-x", "", "a/b", "a'b", "a`b`"];
    expect(statuses("PortCheck", malformed.map((h) => ({ ...port, SSM_host: h })))).toEqual(malformed.map(() => 64));
    expect(statuses("DnsCheck", malformed.map((h) => ({ SSM_name: h, SSM_recordType: "A" })))).toEqual(malformed.map(() => 64));
    expect(
      statuses("PortCheck", [
        { SSM_host: "example.com", SSM_port: "0", SSM_timeoutSec: "2" },
        { SSM_host: "example.com", SSM_port: "65536", SSM_timeoutSec: "2" },
        { SSM_host: "example.com", SSM_port: "80", SSM_timeoutSec: "31" },
      ])
    ).toEqual([64, 64, 64]);
    expect(statuses("DnsCheck", [{ SSM_name: "example.com", SSM_recordType: "ANY" }])).toEqual([64]);
  });

  it("PortCheck refuses link-local and metadata addresses after resolution (skipped where getent is missing)", () => {
    if (sh!("command -v getent >/dev/null 2>&1").status !== 0) return;
    const port = { SSM_port: "80", SSM_timeoutSec: "2" };
    const hosts = ["169.254.169.254", "169.254.170.2", "2852039166", "0xA9FEA9FE", "0251.0376.0251.0376", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254"];
    runDocs("PortCheck", hosts.map((h) => ({ ...port, SSM_host: h }))).forEach((c, i) => {
      // a numeric/odd spelling is either refused as a metadata address (65) or does not resolve at all; it must never connect
      expect([65, 64], `${hosts[i]}: ${c.stdout}${c.stderr}`).toContain(c.status);
      expect(c.stdout).not.toContain("open=true");
    });
  });
});

describe.skipIf(!sh || process.platform === "darwin")("script behaviour: FileRead guards (real files in a private temp dir)", () => {
  const base = `/tmp/zenith-fr-${process.pid}-${Date.now()}`;
  const allowed = `${base}/allowed`;
  const doc = specializeFileRead(ZENITH_SSM_DOCUMENTS.FileRead, [`${allowed}/`, `${base}/exact.txt`]);
  const setup = `
B=${q(base)}; mkdir -p "$B/allowed" "$B/outside"
printf 'hello world\\n' > "$B/allowed/ok.log"
head -c 40000 /dev/zero | tr '\\000' 'a' > "$B/allowed/big.log"
printf 'root:secret\\n' > "$B/outside/passwd"
printf 'key\\n' > "$B/allowed/server.key"
printf 'ENV=1\\n' > "$B/allowed/app.env"
printf 'exact\\n' > "$B/exact.txt"
printf 'nope\\n' > "$B/other.txt"
ln -s "$B/outside/passwd" "$B/allowed/link.log"
ln -s "$B/outside" "$B/allowed/dirlink"
ln -s "$B/exact.txt" "$B/allowed/to-exact.log"
ln -s "$B/other.txt" "$B/allowed/to-other.log"
mkdir -p "$B/allowed/subdir"
`;
  const read = (p: string, maxBytes = "100") => runDoc("FileRead", { SSM_path: p, SSM_maxBytes: maxBytes }, doc, setup);
  const cleanup = () => sh!(`rm -rf ${q(base)}`);

  it("reads an allowed regular file as base64 with size and truncation facts", () => {
    const r = read(`${allowed}/ok.log`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n")).toEqual(["zenith.file.read/v1", `path=${allowed}/ok.log`, "size=12", "truncated=false", `content_b64=${Buffer.from("hello world\n").toString("base64")}`, ""]);
    cleanup();
  });

  it("caps output at 16384 bytes whatever maxBytes says, and reports truncation", () => {
    const r = read(`${allowed}/big.log`, "99999999");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("size=40000");
    expect(r.stdout).toContain("truncated=true");
    const b64 = /content_b64=(.*)/.exec(r.stdout)![1];
    expect(Buffer.from(b64, "base64").length).toBe(16384);
    const small = read(`${allowed}/big.log`, "10");
    expect(Buffer.from(/content_b64=(.*)/.exec(small.stdout)![1], "base64").length).toBe(10);
    cleanup();
  });

  it("refuses traversal, symlink escapes and secret-like names", () => {
    for (const [p, code] of [
      [`${allowed}/../outside/passwd`, 65],
      [`${allowed}/link.log`, 65], // symlink to a file outside the allowlist
      [`${allowed}/dirlink/passwd`, 65], // symlinked directory escape
      [`${allowed}/server.key`, 65],
      [`${allowed}/app.env`, 65],
      [`${base}/other.txt`, 65], // not under an allowed prefix
      ["/etc/passwd", 65],
      [`${allowed}/ok.log;id`, 64],
      [`${allowed}/$(id)`, 64],
      [`${allowed}/a b`, 64],
      ["relative/path", 64],
      ["", 64],
    ] as [string, number][]) {
      const r = read(p);
      expect(r.status, `${p}: ${r.stderr}`).toBe(code);
      expect(r.stdout, p).toBe("");
    }
    cleanup();
  });

  it("a symlink may point at another allowed file, but not at an unlisted one", () => {
    expect(read(`${allowed}/to-exact.log`).status).toBe(0);
    expect(read(`${allowed}/to-other.log`).status).toBe(65);
    cleanup();
  });

  it("exact-file allowlist entries allow only that file", () => {
    expect(read(`${base}/exact.txt`).status).toBe(0);
    expect(read(`${base}/exact.txt.bak`).status).toBe(65);
    cleanup();
  });

  it("reports missing files and non-regular files", () => {
    expect(read(`${allowed}/missing.log`).status).toBe(66);
    expect(read(`${allowed}/subdir`).status).toBe(66);
    expect(read(`${allowed}/ok.log`, "abc").status).toBe(64);
    expect(read(`${allowed}/ok.log`, "0").status).toBe(64);
    cleanup();
  });
});
