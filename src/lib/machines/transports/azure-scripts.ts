/**
 * Fixed Linux scripts for managed Azure Run Command. Semantic implementations
 * reuse the guarded SSM document bodies, with named SSM_* environment parameters.
 * Exec uses a JSON argv vector in protected parameters and subprocess without a shell.
 * Nothing from a request is inserted in source text. A Python 3 collector drains
 * both streams but retains only bounded prefixes, encoding a complete wire result
 * below Azure's last-4-KiB instanceView limit. No guest temporary output files.
 * Contract/local Python tests only; delivery by a live Azure agent is unverified.
 */
import { isDeniedFilePath, pathAllowed } from "../guards";
import { MachineOperationError } from "../errors";
import { DEFAULT_FILE_READ_PREFIXES } from "../limits";
import type { MachineOperation, MachineRequest } from "../types";
import { invalidCloudArgs } from "./cloud-request";
import { buildSsmDocuments, checkDocumentParameters, OPERATION_DOCUMENTS, type SsmCommandDocument, type SsmDocumentOperation, type SsmDocumentOptions } from "./aws-ssm-docs";

export const AZURE_STDOUT_BYTES = 2304;
export const AZURE_STDERR_BYTES = 384;
export const AZURE_FILE_READ_MAX_BYTES = 1024;
export const AZURE_WIRE_HEADER = "zenith.azure/v1\n";
export const AZURE_SUPPORTED: readonly MachineOperation[] = [...Object.keys(OPERATION_DOCUMENTS) as SsmDocumentOperation[], "machine.exec"];

export interface AzureScriptPlan {
  script: string;
  parameters: { name: string; value: string }[];
  protectedParameters: { name: string; value: string }[];
  docOp?: SsmDocumentOperation;
}

/** Python source is independent of request values, including exec argv/cwd/timeouts. */
function collector(doc?: SsmCommandDocument): string {
  const setup = doc ? [
    `script = base64.b64decode("${Buffer.from(doc.mainSteps[0].inputs.runCommand.join("\n") + "\n").toString("base64")}")`,
    `names = ${JSON.stringify(Object.keys(doc.parameters).filter((n) => n !== "executionTimeout").map((n) => `SSM_${n}`))}`,
    'env.update({n: os.environ.get(n, "") for n in names})',
    'argv = ["/bin/sh", "-s"]',
    'cwd = None',
  ] : [
    'script = None',
    'argv = json.loads(base64.b64decode(os.environ.get("ZENITH_ARGV_B64", ""), validate=True))',
    'if not isinstance(argv, list) or not 1 <= len(argv) <= 32 or any(not isinstance(a, str) or "\\x00" in a or len(a) > 4096 for a in argv) or sum(map(len, argv)) > 32768:',
    '    raise ValueError()',
    'cwd = os.environ.get("ZENITH_CWD") or None',
  ];
  return [
    'import base64, json, os, signal, subprocess, threading, time',
    `limits = {"stdout": ${AZURE_STDOUT_BYTES}, "stderr": ${AZURE_STDERR_BYTES}}`,
    'out = {"stdout": bytearray(), "stderr": bytearray()}',
    'truncated = False',
    'timed_out = False',
    'code = 64',
    'env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}',
    'def collect(stream, name):',
    '    global truncated',
    '    with stream:',
    '        while True:',
    '            chunk = stream.read(4096)',
    '            if not chunk: break',
    '            keep = max(0, limits[name] - len(out[name]))',
    '            out[name].extend(chunk[:keep])',
    '            if len(chunk) > keep: truncated = True',
    'def stop(proc):',
    '    try:',
    '        if os.name == "posix": os.killpg(proc.pid, signal.SIGKILL)',
    '        else: proc.kill()',
    '    except ProcessLookupError: pass',
    'try:',
    ...setup.map((l) => `    ${l}`),
    '    seconds = int(os.environ.get("ZENITH_TIMEOUT_SEC", "0"))',
    '    if not 1 <= seconds <= 300: raise ValueError()',
    '    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if script is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)',
    '    deadline = time.monotonic() + seconds',
    '    threads = [threading.Thread(target=collect, args=(stream, name), daemon=True) for stream, name in [(proc.stdout, "stdout"), (proc.stderr, "stderr")]]',
    '    for thread in threads: thread.start()',
    '    if script is not None:',
    '        try: proc.stdin.write(script); proc.stdin.close()',
    '        except BrokenPipeError: pass',
    '    try: code = proc.wait(timeout=max(0.01, deadline - time.monotonic()))',
    '    except subprocess.TimeoutExpired:',
    '        timed_out = True',
    '        stop(proc)',
    '        code = proc.wait()',
    '    for thread in threads: thread.join(max(0, deadline - time.monotonic()))',
    '    if any(thread.is_alive() for thread in threads):',
    '        timed_out = True',
    '        stop(proc)',
    '        for thread in threads: thread.join(1)',
    'except (FileNotFoundError, PermissionError):',
    '    code = 69',
    'except (ValueError, TypeError):',
    '    code = 64',
    `print(${JSON.stringify(AZURE_WIRE_HEADER.trim())})`,
    'print(json.dumps({"stdout": base64.b64encode(out["stdout"]).decode("ascii"), "stderr": base64.b64encode(out["stderr"]).decode("ascii"), "exitCode": code, "truncated": truncated, "timedOut": timed_out}, separators=(",", ":")))',
  ].join("\n") + "\n";
}

/** Shell only launches the fixed Python collector; request values arrive as named environment parameters. */
export function azureGuestScript(doc?: SsmCommandDocument): string {
  return '#!/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\ncommand -v python3 >/dev/null 2>&1 || exit 69\nexec python3 -I - <<\'ZENITH_FIXED_PYTHON\'\n' + collector(doc) + 'ZENITH_FIXED_PYTHON\n';
}

export function azureScriptPlans(options: Pick<SsmDocumentOptions, "fileReadPrefixes" | "restartAllow"> = {}): (req: MachineRequest) => AzureScriptPlan {
  const prefixes = options.fileReadPrefixes ?? DEFAULT_FILE_READ_PREFIXES;
  const docs = Object.fromEntries(buildSsmDocuments(options).map((d) => [d.suffix, d.document]));
  return (req) => {
    const a = req.args;
    const parameters = [{ name: "ZENITH_TIMEOUT_SEC", value: String(req.operation === "machine.exec" ? Math.min(req.timeoutSec, Number(a.timeoutSec)) : req.timeoutSec) }];
    if (req.operation === "machine.exec") {
      return { script: azureGuestScript(), parameters, protectedParameters: [
        { name: "ZENITH_ARGV_B64", value: Buffer.from(JSON.stringify(a.argv)).toString("base64") },
        { name: "ZENITH_CWD", value: typeof a.cwd === "string" ? a.cwd : "" },
      ] };
    }
    const op = req.operation as SsmDocumentOperation;
    const doc = docs[OPERATION_DOCUMENTS[op]];
    if (!doc) throw new MachineOperationError("unsupported_operation", "Azure has no fixed script for this operation");
    const values: Record<string, string> = { executionTimeout: String(req.timeoutSec) };
    for (const [name, definition] of Object.entries(doc.parameters)) {
      if (name === "executionTimeout") continue;
      const value = a[name] ?? definition.default;
      if (value !== undefined) values[name] = String(value);
    }
    if (req.operation === "container.list" && a.labelSelector !== undefined) throw invalidCloudArgs();
    if (req.operation === "file.read") {
      const path = String(a.path);
      if (!pathAllowed(path, prefixes) || isDeniedFilePath(path)) throw new MachineOperationError("denied", "path is not readable under this environment's allowlist");
      // Nested base64 plus the path/header must fit in the collector's stdout budget.
      const available = Math.floor((AZURE_STDOUT_BYTES - Buffer.byteLength(path) - 256) * 3 / 4);
      values.maxBytes = String(Math.min(Number(a.maxBytes), req.maxOutputBytes, AZURE_FILE_READ_MAX_BYTES, available));
    }
    if (checkDocumentParameters(doc, values).length) throw invalidCloudArgs();
    for (const [name, value] of Object.entries(values)) {
      if (name !== "executionTimeout") parameters.push({ name: `SSM_${name}`, value });
    }
    return { script: azureGuestScript(doc), parameters, protectedParameters: [], docOp: op };
  };
}
