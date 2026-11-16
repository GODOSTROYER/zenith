/**
 * The Zenith-owned SSM Command documents, as data.
 *
 * The documents live as JSON under `deploy/aws/ssm-documents/` (one file per
 * document, schemaVersion 2.2, Linux only). This module loads them, maps
 * semantic operations to them, checks a parameter set against a document's own
 * `allowedPattern`s before anything is sent, and compiles them to OpenTofu
 * JSON (`aws_ssm_document`) for the environment bootstrap.
 *
 * Security model of a document (defence in depth, in order):
 *   1. Every parameter is a typed String with an `allowedPattern` (validated
 *      by SSM's API in Java regex and again by the agent in Go RE2) and a
 *      `maxChars`. The patterns are the same alphabets `args.ts` enforces.
 *   2. Every parameter uses `interpolationType: ENV_VAR`, so its value reaches
 *      the script as the environment variable `SSM_<name>` and is NEVER pasted
 *      into the script text. The script reads it only as `"${SSM_name-}"`
 *      (double-quoted), validates it again with `case` patterns, and never
 *      uses `eval`, `sh -c <value>` or backticks.
 *   3. The script pins `PATH`, disables globbing (`set -f`) and exits with a
 *      documented code: 64 invalid input, 65 refused by a local guard, 66 not
 *      found, 69 tool unavailable.
 *
 * Not verified live (no AWS account here): that SSM delivers `ENV_VAR`
 * parameters exactly as documented on this agent version (needs SSM Agent
 * ≥ 3.3.2746.0; older agents leave the variable empty and every script then
 * fails closed with exit 64), and that `aws_ssm_document` accepts these
 * documents. The scripts themselves were run under dash and bash locally.
 */
import type { TofuFragment } from "@/lib/drivers/types";
import type { MachineOperation } from "../types";
import { DEFAULT_FILE_READ_PREFIXES, MAX_PATH_CHARS } from "../limits";
import { isProtectedUnit, normalizeAbsolutePath } from "../guards";
import { UNIT_NAME_RE } from "../args";
import inspect from "../../../../deploy/aws/ssm-documents/Zenith-MachineInspect.json";
import processList from "../../../../deploy/aws/ssm-documents/Zenith-ProcessList.json";
import serviceStatus from "../../../../deploy/aws/ssm-documents/Zenith-ServiceStatus.json";
import serviceRestart from "../../../../deploy/aws/ssm-documents/Zenith-ServiceRestart.json";
import containerList from "../../../../deploy/aws/ssm-documents/Zenith-ContainerList.json";
import containerInspect from "../../../../deploy/aws/ssm-documents/Zenith-ContainerInspect.json";
import containerLogs from "../../../../deploy/aws/ssm-documents/Zenith-ContainerLogs.json";
import fileRead from "../../../../deploy/aws/ssm-documents/Zenith-FileRead.json";
import portCheck from "../../../../deploy/aws/ssm-documents/Zenith-PortCheck.json";
import dnsCheck from "../../../../deploy/aws/ssm-documents/Zenith-DnsCheck.json";
import systemMetrics from "../../../../deploy/aws/ssm-documents/Zenith-SystemMetrics.json";
import systemLogs from "../../../../deploy/aws/ssm-documents/Zenith-SystemLogs.json";

/* --------------------------------- types ---------------------------------- */

export interface SsmDocParameter {
  type: "String";
  description: string;
  default?: string;
  allowedPattern: string;
  maxChars: number;
  /** absent only on `executionTimeout`, which is used by the plugin input, never by the script */
  interpolationType?: "ENV_VAR";
}

export interface SsmCommandDocument {
  schemaVersion: "2.2";
  description: string;
  parameters: Record<string, SsmDocParameter>;
  mainSteps: {
    action: "aws:runShellScript";
    name: string;
    precondition: { StringEquals: [string, string] };
    inputs: { timeoutSeconds: string; runCommand: string[] };
  }[];
}

/** `Zenith-<suffix>` is the default document name; the suffixes are fixed. */
export const ZENITH_SSM_DOCUMENT_SUFFIXES = [
  "MachineInspect",
  "ProcessList",
  "ServiceStatus",
  "ServiceRestart",
  "ContainerList",
  "ContainerInspect",
  "ContainerLogs",
  "FileRead",
  "PortCheck",
  "DnsCheck",
  "SystemMetrics",
  "SystemLogs",
] as const;
export type ZenithSsmDocumentSuffix = (typeof ZENITH_SSM_DOCUMENT_SUFFIXES)[number];

const cast = (d: unknown) => d as SsmCommandDocument;

export const ZENITH_SSM_DOCUMENTS: Readonly<Record<ZenithSsmDocumentSuffix, SsmCommandDocument>> = {
  MachineInspect: cast(inspect),
  ProcessList: cast(processList),
  ServiceStatus: cast(serviceStatus),
  ServiceRestart: cast(serviceRestart),
  ContainerList: cast(containerList),
  ContainerInspect: cast(containerInspect),
  ContainerLogs: cast(containerLogs),
  FileRead: cast(fileRead),
  PortCheck: cast(portCheck),
  DnsCheck: cast(dnsCheck),
  SystemMetrics: cast(systemMetrics),
  SystemLogs: cast(systemLogs),
};

/** semantic operation → the document that implements it */
export const OPERATION_DOCUMENTS = {
  "machine.inspect": "MachineInspect",
  "process.list": "ProcessList",
  "service.status": "ServiceStatus",
  "machine.service.restart": "ServiceRestart",
  "container.list": "ContainerList",
  "container.inspect": "ContainerInspect",
  "container.logs": "ContainerLogs",
  "file.read": "FileRead",
  "network.portCheck": "PortCheck",
  "network.dnsCheck": "DnsCheck",
  "system.metrics": "SystemMetrics",
  "system.logs": "SystemLogs",
} as const satisfies Partial<Record<MachineOperation, ZenithSsmDocumentSuffix>>;
export type SsmDocumentOperation = keyof typeof OPERATION_DOCUMENTS;

export const DEFAULT_SSM_DOCUMENT_PREFIX = "Zenith-";
/** the AWS-owned document `machine.exec` uses; the only place a command line is sent as text */
export const AWS_RUN_SHELL_SCRIPT = "AWS-RunShellScript";

export const documentNameFor = (suffix: ZenithSsmDocumentSuffix, prefix = DEFAULT_SSM_DOCUMENT_PREFIX): string => `${prefix}${suffix}`;

/* ------------------------------ specialization ------------------------------ */

const PATH_CHARS = "[A-Za-z0-9._@:+=,/-]";
const escapeRe = (s: string): string => s.replace(/[.+]/g, "\\$&");

/** The allowedPattern of FileRead's `path` parameter for a prefix list (same rule the JSON default was generated with). */
export function filePathPattern(prefixes: readonly string[]): string {
  const dirs = prefixes.filter((p) => p.endsWith("/")).map(escapeRe);
  const files = prefixes.filter((p) => !p.endsWith("/")).map(escapeRe);
  const alts: string[] = [];
  if (dirs.length) alts.push(`(${dirs.join("|")})${PATH_CHARS}{0,${MAX_PATH_CHARS - 24}}`);
  alts.push(...files);
  return `^(${alts.join("|")})$`;
}

function assertPrefixes(prefixes: readonly string[]): void {
  if (prefixes.length === 0) throw new Error("fileReadPrefixes must not be empty");
  for (const p of prefixes) {
    const n = normalizeAbsolutePath(p);
    if (!n.ok || p === "/" || (p.endsWith("/") ? n.path + "/" : n.path) !== p) {
      throw new Error(`fileReadPrefixes entry is not a normalized absolute path (directories end with '/'): ${JSON.stringify(p)}`);
    }
  }
}

function assertRestartUnits(units: readonly string[]): void {
  for (const u of units) {
    if (!UNIT_NAME_RE.test(u) || u.startsWith("-")) throw new Error(`restartAllow entry is not a unit name: ${JSON.stringify(u)}`);
    if (isProtectedUnit(u)) throw new Error(`restartAllow entry is a protected unit: ${JSON.stringify(u)}`);
  }
}

const clone = (d: SsmCommandDocument): SsmCommandDocument => JSON.parse(JSON.stringify(d)) as SsmCommandDocument;

function replaceScriptLine(doc: SsmCommandDocument, startsWith: string, line: string): void {
  const lines = doc.mainSteps[0].inputs.runCommand;
  const i = lines.findIndex((l) => l.startsWith(startsWith));
  if (i < 0) throw new Error(`document script has no line starting with ${startsWith}`);
  lines[i] = line;
}

/** FileRead with an environment-specific read allowlist (parameter pattern and script check change together). */
export function specializeFileRead(doc: SsmCommandDocument, prefixes: readonly string[]): SsmCommandDocument {
  assertPrefixes(prefixes);
  const out = clone(doc);
  out.parameters.path.allowedPattern = filePathPattern(prefixes);
  replaceScriptLine(out, "allow='", `allow='${prefixes.join(" ")}'`);
  return out;
}

/** ServiceRestart restricted to an explicit unit list (pattern and script allowlist change together). */
export function specializeServiceRestart(doc: SsmCommandDocument, units: readonly string[]): SsmCommandDocument {
  assertRestartUnits(units);
  const out = clone(doc);
  if (units.length === 0) return out;
  out.parameters.unit.allowedPattern = `^(${units.map(escapeRe).join("|")})$`;
  replaceScriptLine(out, "allow='", `allow='${units.join(" ")}'`);
  return out;
}

export interface SsmDocumentOptions {
  /** document name prefix (default `Zenith-`); change it when several Zenith environments share an account and region */
  namePrefix?: string;
  /** default {@link DEFAULT_FILE_READ_PREFIXES} */
  fileReadPrefixes?: readonly string[];
  /** when set, only these units can be restarted through `machine.service.restart` */
  restartAllow?: readonly string[];
}

export interface BuiltSsmDocument {
  suffix: ZenithSsmDocumentSuffix;
  name: string;
  document: SsmCommandDocument;
  /** the exact JSON text to deploy as the document content */
  content: string;
}

export function buildSsmDocuments(opts: SsmDocumentOptions = {}): BuiltSsmDocument[] {
  return ZENITH_SSM_DOCUMENT_SUFFIXES.map((suffix) => {
    let document = ZENITH_SSM_DOCUMENTS[suffix];
    if (suffix === "FileRead") document = specializeFileRead(document, opts.fileReadPrefixes ?? DEFAULT_FILE_READ_PREFIXES);
    if (suffix === "ServiceRestart" && opts.restartAllow?.length) document = specializeServiceRestart(document, opts.restartAllow);
    return { suffix, name: documentNameFor(suffix, opts.namePrefix), document, content: JSON.stringify(document, null, 2) };
  });
}

/* ---------------------------- parameter validation --------------------------- */

/**
 * Check a parameter set against the document's own declared parameters:
 * nothing undeclared, every required one present, every value within
 * `maxChars` and matching `allowedPattern`. Returns problem descriptions
 * (names and rules only, never values); empty means "SSM will accept this".
 */
export function checkDocumentParameters(doc: SsmCommandDocument, params: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(params)) {
    if (!(name in doc.parameters)) problems.push(`${name}: not a parameter of the document`);
  }
  for (const [name, def] of Object.entries(doc.parameters)) {
    const v = params[name];
    if (v === undefined) {
      if (def.default === undefined) problems.push(`${name}: required`);
      continue;
    }
    if (v.length > def.maxChars) problems.push(`${name}: longer than ${def.maxChars} characters`);
    else if (!new RegExp(def.allowedPattern).test(v)) problems.push(`${name}: does not match the document's allowedPattern`);
  }
  return problems;
}

/* -------------------------------- OpenTofu --------------------------------- */

/**
 * Escape a string for an OpenTofu JSON-syntax string value: HCL templates
 * treat `${` and `%{` as interpolation/directive starts, and shell scripts are
 * full of `${VAR}`. `$${` and `%%{` are the literal escapes.
 */
export function escapeHclTemplate(s: string): string {
  return s.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

export interface SsmTofuOptions extends SsmDocumentOptions {
  /** tags applied to every document (`ctx.tags` in drivers) */
  tags?: Record<string, string>;
}

/**
 * The documents as `aws_ssm_document` resources for the environment
 * bootstrap. The fragment follows `TofuFragment`: the workspace assembler adds
 * the provider and backend. Deterministic (fixed order, stable JSON).
 */
export function ssmDocumentsTofu(opts: SsmTofuOptions = {}): TofuFragment {
  const resource: Record<string, Record<string, unknown>> = {};
  const addresses: string[] = [];
  for (const d of buildSsmDocuments(opts)) {
    const label = `zenith_ssm_${d.suffix.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
    resource[label] = {
      name: d.name,
      document_type: "Command",
      document_format: "JSON",
      target_type: "/AWS::EC2::Instance",
      content: escapeHclTemplate(d.content),
      ...(opts.tags && Object.keys(opts.tags).length ? { tags: opts.tags } : {}),
    };
    addresses.push(`aws_ssm_document.${label}`);
  }
  return { resource: { aws_ssm_document: resource }, addresses };
}
