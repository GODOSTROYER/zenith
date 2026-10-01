/**
 * Generate `docs/platform/CAPABILITY-MATRIX.md` from what the code declares —
 * never from what anyone remembers (architecture invariant 8, ADR-0004).
 *
 *     npx tsx scripts/docs/capability-matrix.ts            # rewrite the file
 *     npx tsx scripts/docs/capability-matrix.ts --check    # exit 1 if it is out of date or has problems, write nothing
 *
 * Inputs, all read from the code on the current branch:
 *   - the resource-driver registry (`listDrivers()`), populated by importing
 *     `src/lib/providers/<provider>/drivers/index.ts` for every provider whose
 *     file exists (the provider-level index, which concatenates the groups and
 *     registers them), plus
 *   - driver GROUP modules, `src/lib/providers/<provider>/drivers/<group>/index.ts`,
 *     which export `ResourceDriver`s without registering them. A driver that is
 *     merged as a module but that no provider-level index registers is listed,
 *     with its declared evidence, and marked "not registered": it exists in the
 *     tree and `getDriver()` cannot find it. A provider with neither is reported
 *     as "none merged", not skipped silently and not guessed at. An index that
 *     exists but throws on import is an error: a broken driver set must not
 *     produce a reassuring, empty matrix.
 *   - the observability `SOURCE_EVIDENCE` table;
 *   - the capability catalog (`CAPABILITIES`).
 *
 * What it does and does not prove. It renders each driver's own
 * `capabilities.evidence` declaration and cross-checks that declaration against
 * the driver's shape (a flag without evidence, evidence without a flag, an
 * operation the catalog does not know, a declared operation with no
 * implementation). It cannot verify that an evidence level is true: `contract`
 * means only mocked SDK / HTTP tests, and nothing here raises a level. A `real`
 * entry is listed prominently and `tests/docs/capability-matrix.test.ts` fails
 * on any, because no live-account acceptance run has been recorded yet.
 *
 * The output is deterministic: no clock, no git SHA, sorted everywhere, so a
 * second run is byte-identical and `--check` is a meaningful gate.
 *
 * Exit codes: 0 ok / written, 1 `--check` found the file out of date or the
 * drivers inconsistent, 2 usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CAPABILITIES, type CapabilityDef } from "@/lib/capabilities/catalog";
import { listDrivers, type EvidenceLevel, type ResourceDriver } from "@/lib/drivers/types";
import { SOURCE_EVIDENCE, type SourceEvidence } from "@/lib/observability/evidence";
import { NATIVE_PREFIX } from "@/lib/resources/native-types";

export const MATRIX_RELATIVE_PATH = "docs/platform/CAPABILITY-MATRIX.md";

/** Strongest first. */
export const EVIDENCE_LEVELS = ["real", "emulated", "contract", "simulated"] as const satisfies readonly EvidenceLevel[];
const STRENGTH: Record<EvidenceLevel, number> = { real: 3, emulated: 2, contract: 1, simulated: 0 };

export const CORE_OPERATIONS = ["compile", "observe", "runtime", "verify", "discover"] as const;
export type CoreOperation = (typeof CORE_OPERATIONS)[number];

export type CellEvidence = EvidenceLevel | "undeclared";

export interface CoreCell {
  supported: boolean;
  evidence?: CellEvidence;
}

export interface OperationCell {
  capability: string;
  evidence: CellEvidence;
  /** false when the capability catalog has no such name */
  known: boolean;
}

export interface DriverRow {
  /** true when the driver is in the runtime registry (`getDriver` finds it); false when it is only a merged module */
  registered: boolean;
  provider: string;
  nativeType: string;
  kind: string;
  driverId: string;
  core: Record<CoreOperation, CoreCell>;
  operations: OperationCell[];
}

export interface MatrixProblem {
  driver: string;
  message: string;
}

export interface ProviderDiscovery {
  provider: string;
  /**
   * `loaded`: the provider-level `drivers/index.ts` exists and was imported.
   * `groups`: there is no provider-level index, but driver group modules exist.
   * `absent`: neither is on this branch.
   */
  status: "loaded" | "groups" | "absent";
  /** exported `register…Drivers` functions that were called */
  registrars: string[];
  /** driver group modules (`drivers/<group>/index.ts`) that were imported, sorted */
  groups: string[];
  /** the `ResourceDriver`s those group modules export (registered or not), sorted by id */
  groupDrivers: ResourceDriver[];
}

export interface MatrixData {
  /** every provider key, in declaration order */
  providers: string[];
  discovery: ProviderDiscovery[];
  rows: DriverRow[];
  sources: { id: string; level: EvidenceLevel; basis: string }[];
  capabilities: CapabilityDef[];
  /** every cell or source claiming `real`, as `<id> <operation>` */
  realClaims: string[];
  problems: MatrixProblem[];
}

/* -------------------------------- discovery ------------------------------- */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isEvidenceLevel = (value: unknown): value is EvidenceLevel => typeof value === "string" && (EVIDENCE_LEVELS as readonly string[]).includes(value);

/** A value shaped like a `ResourceDriver` (what a group module exports). */
function isDriverShaped(value: unknown): value is ResourceDriver {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.provider === "string" && typeof v.nativeType === "string" && typeof v.capabilities === "object" && v.capabilities !== null;
}

/**
 * Import every provider's drivers index that exists under `providersRoot`
 * (default `src/lib/providers`) and call its `register...Drivers` exports; then
 * import every driver group module (`drivers/<group>/index.ts`, excluding
 * `shared`) and collect the drivers it exports. Absence is tolerated and
 * reported; a failing import is not.
 */
export async function loadProviderDrivers(options: { repoRoot?: string; providers?: readonly string[] } = {}): Promise<ProviderDiscovery[]> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const providers = options.providers ?? Object.keys(NATIVE_PREFIX);
  const out: ProviderDiscovery[] = [];
  for (const provider of providers) {
    const driversDir = path.join(repoRoot, "src", "lib", "providers", provider, "drivers");
    const index = path.join(driversDir, "index.ts");
    let registrars: string[] = [];
    if (fs.existsSync(index)) {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(index).href)) as Record<string, unknown>;
      registrars = Object.keys(mod)
        .filter((name) => /^register\w*Drivers$/.test(name) && typeof mod[name] === "function")
        .sort();
      for (const name of registrars) (mod[name] as () => void)();
    }

    const groups: string[] = [];
    const found = new Map<string, ResourceDriver>();
    if (fs.existsSync(driversDir)) {
      const dirs = fs
        .readdirSync(driversDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "shared" && !d.name.startsWith("_") && fs.existsSync(path.join(driversDir, d.name, "index.ts")))
        .map((d) => d.name)
        .sort();
      for (const group of dirs) {
        const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(driversDir, group, "index.ts")).href)) as Record<string, unknown>;
        groups.push(group);
        for (const value of Object.values(mod)) {
          for (const candidate of Array.isArray(value) ? value : [value]) if (isDriverShaped(candidate)) found.set(candidate.id, candidate);
        }
      }
    }
    const groupDrivers = [...found.values()].sort((a, b) => cmp(a.id, b.id));
    const status: ProviderDiscovery["status"] = fs.existsSync(index) ? "loaded" : groups.length > 0 ? "groups" : "absent";
    out.push({ provider, status, registrars, groups, groupDrivers });
  }
  return out;
}

function defaultRepoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

/* ------------------------------ data assembly ----------------------------- */

export interface BuildMatrixInput {
  drivers: readonly ResourceDriver[];
  /** ids of the drivers in the runtime registry; default: all of `drivers` */
  registered?: ReadonlySet<string>;
  providers: readonly string[];
  discovery: readonly ProviderDiscovery[];
  sourceEvidence: Readonly<Record<string, SourceEvidence>>;
  capabilities: Readonly<Record<string, CapabilityDef>>;
}

function cellEvidence(driver: ResourceDriver, key: string): CellEvidence {
  const value = (driver.capabilities.evidence as Record<string, unknown>)[key];
  return isEvidenceLevel(value) ? value : "undeclared";
}

/** Pure: the matrix data for a set of drivers. Inconsistencies become `problems`; nothing is repaired. */
export function buildMatrix(input: BuildMatrixInput): MatrixData {
  const problems: MatrixProblem[] = [];
  const realClaims: string[] = [];
  const rows: DriverRow[] = [];

  for (const driver of input.drivers) {
    const caps = driver.capabilities;
    const flag = (op: CoreOperation): boolean => caps[op] === true;
    const core = {} as Record<CoreOperation, CoreCell>;

    for (const op of CORE_OPERATIONS) {
      const supported = flag(op);
      const declared = (caps.evidence as Record<string, unknown>)[op];
      if (supported) {
        const evidence = cellEvidence(driver, op);
        if (evidence === "undeclared") {
          problems.push({
            driver: driver.id,
            message: declared === undefined ? `supports \`${op}\` but declares no evidence level for it` : `declares the invalid evidence level ${JSON.stringify(declared)} for \`${op}\``,
          });
        }
        if (evidence === "real") realClaims.push(`${driver.id} ${op}`);
        core[op] = { supported, evidence };
      } else {
        if (declared !== undefined) problems.push({ driver: driver.id, message: `declares evidence for \`${op}\` but does not support it` });
        core[op] = { supported };
      }
      const implemented = typeof (driver as unknown as Record<string, unknown>)[op] === "function";
      if (supported !== implemented) {
        problems.push({
          driver: driver.id,
          message: supported ? `declares \`${op}\` but has no \`${op}\` implementation` : `has a \`${op}\` implementation but declares \`${op}: false\``,
        });
      }
    }

    const declaredOps = [...new Set(caps.operations)].sort(cmp);
    const implementedOps = Object.keys(driver.operations ?? {}).sort(cmp);
    const operations: OperationCell[] = declaredOps.map((capability) => {
      const evidence = cellEvidence(driver, capability);
      const known = Object.prototype.hasOwnProperty.call(input.capabilities, capability);
      if (!known) problems.push({ driver: driver.id, message: `declares the operation \`${capability}\`, which is not in the capability catalog` });
      if (evidence === "undeclared") problems.push({ driver: driver.id, message: `declares the operation \`${capability}\` but no evidence level for it` });
      if (evidence === "real") realClaims.push(`${driver.id} ${capability}`);
      if (!implementedOps.includes(capability)) problems.push({ driver: driver.id, message: `declares the operation \`${capability}\` but has no implementation for it` });
      return { capability, evidence, known };
    });
    for (const name of implementedOps) {
      if (!declaredOps.includes(name)) problems.push({ driver: driver.id, message: `implements the operation \`${name}\` but does not declare it in capabilities.operations` });
    }
    const allowedKeys = new Set<string>([...CORE_OPERATIONS, ...declaredOps]);
    for (const key of Object.keys(caps.evidence)) {
      if (!allowedKeys.has(key)) {
        problems.push({ driver: driver.id, message: `declares evidence for \`${key}\`, which is neither a core operation nor a declared operation` });
      }
    }

    rows.push({ registered: input.registered ? input.registered.has(driver.id) : true, provider: driver.provider, nativeType: driver.nativeType, kind: driver.kind, driverId: driver.id, core, operations });
  }

  rows.sort((a, b) => cmp(a.provider, b.provider) || cmp(a.nativeType, b.nativeType) || cmp(a.driverId, b.driverId));
  problems.sort((a, b) => cmp(a.driver, b.driver) || cmp(a.message, b.message));

  const sources = Object.entries(input.sourceEvidence)
    .map(([id, e]) => ({ id, level: e.level, basis: e.basis }))
    .sort((a, b) => cmp(a.id, b.id));
  for (const s of sources) {
    if (!isEvidenceLevel(s.level)) problems.push({ driver: `observability:${s.id}`, message: `has the invalid evidence level ${JSON.stringify(s.level)}` });
    if (s.level === "real") realClaims.push(`observability:${s.id}`);
  }

  const capabilities = Object.values(input.capabilities).sort((a, b) => a.defaultAutonomy - b.defaultAutonomy || cmp(a.name, b.name));
  return {
    providers: [...input.providers],
    discovery: [...input.discovery],
    rows,
    sources,
    capabilities,
    realClaims: realClaims.sort(cmp),
    problems,
  };
}

/** Read the live registry (after importing what exists), the group modules, the observability table and the catalog. */
export async function collectMatrix(options: { repoRoot?: string } = {}): Promise<MatrixData> {
  const providers = Object.keys(NATIVE_PREFIX);
  const discovery = await loadProviderDrivers({ repoRoot: options.repoRoot, providers });
  const registry = listDrivers();
  const registered = new Set(registry.map((d) => d.id));
  const byId = new Map<string, ResourceDriver>(registry.map((d) => [d.id, d]));
  for (const d of discovery) for (const driver of d.groupDrivers) if (!byId.has(driver.id)) byId.set(driver.id, driver);
  return buildMatrix({
    drivers: [...byId.values()],
    registered,
    providers,
    discovery,
    sourceEvidence: SOURCE_EVIDENCE,
    capabilities: CAPABILITIES as Record<string, CapabilityDef>,
  });
}

/** Per provider: the weakest declared level for `capability` among that provider's drivers. */
export function providerSupport(rows: readonly DriverRow[], capability: string): { provider: string; weakest: CellEvidence; drivers: number }[] {
  const byProvider = new Map<string, { weakest: CellEvidence; drivers: number }>();
  for (const r of rows) {
    const op = r.operations.find((o) => o.capability === capability);
    if (!op) continue;
    const cur = byProvider.get(r.provider);
    let weakest: CellEvidence = op.evidence;
    if (cur) {
      if (cur.weakest === "undeclared" || op.evidence === "undeclared") weakest = "undeclared";
      else weakest = STRENGTH[cur.weakest] <= STRENGTH[op.evidence] ? cur.weakest : op.evidence;
    }
    byProvider.set(r.provider, { weakest, drivers: (cur?.drivers ?? 0) + 1 });
  }
  return [...byProvider.entries()].sort(([a], [b]) => cmp(a, b)).map(([provider, v]) => ({ provider, ...v }));
}

/* --------------------------------- render --------------------------------- */

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (text: string): string => `\`${text}\``;
const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

const coreCell = (c: CoreCell): string => (c.supported ? (c.evidence === "undeclared" ? "**undeclared**" : code(c.evidence ?? "undeclared")) : "—");

const AUTONOMY_LABEL: Record<number, string> = { 0: "0", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6 (never unattended)" };

export function renderMatrix(data: MatrixData): string {
  const out: string[] = [];
  const push = (...lines: string[]): void => void out.push(...lines);

  push(
    "# Capability matrix",
    "",
    "<!-- GENERATED FILE: DO NOT EDIT. Source: scripts/docs/capability-matrix.ts. Regenerate: npx tsx scripts/docs/capability-matrix.ts -->",
    "",
    "This file is generated from the code: the resource drivers (the runtime registry",
    "and the driver group modules), the observability evidence table and the capability",
    "catalog. It is never written by",
    "hand. To refresh it after a driver merges or an evidence level changes, run",
    "`npx tsx scripts/docs/capability-matrix.ts`; `--check` exits non-zero when the",
    "committed file is out of date, and `tests/docs/capability-matrix.test.ts` runs it.",
    "",
    "What the matrix is: what each driver *declares*. The generator cross-checks each",
    "declaration against the driver's shape (see [Problems](#problems)), but it cannot",
    "verify that a level is true. A label is only as good as the test or run behind it.",
    "",
    "## Evidence levels",
    "",
    table(
      ["Level", "Meaning", "Evidence that backs it"],
      [
        [code("real"), "Exercised against the real provider in a live acceptance run.", "A recorded live run with real credentials, started by hand through the dispatch-only workflow `.github/workflows/live-acceptance.yml`. **No such run exists yet.**"],
        [code("emulated"), "Exercised against an emulator (LocalStack, kind, PGlite).", "A recorded run against that emulator."],
        [code("contract"), "Only mocked SDK or HTTP contract tests.", "Unit tests with `aws-sdk-client-mock`, fake clients or a local fake HTTP server. Shows the code matches the documented API shape, nothing about a real account."],
        [code("simulated"), "Generated data; nothing outside Zenith was inspected.", "The sandbox. Never presented as real."],
      ]
    ),
    "",
    `A cell reading **undeclared** means the driver supports the operation but declares no valid evidence level for it; that is listed under [Problems](#problems). A dash means the driver does not support that operation.`,
    ""
  );

  /* ------------------------------ status summary ----------------------------- */
  const withDrivers = new Set(data.rows.map((r) => r.provider));
  push("## Status on this branch", "");
  if (data.realClaims.length > 0) {
    push(
      `> **${data.realClaims.length} entr${data.realClaims.length === 1 ? "y claims" : "ies claim"} \`real\`:** ${data.realClaims.map(code).join(", ")}. Zenith has no recorded live-account acceptance run; treat this as an error until one is linked here.`,
      ""
    );
  } else {
    push("No entry claims `real`: there is no live-account acceptance evidence yet.", "");
  }
  push(
    table(
      ["Provider", "Provider-level drivers index", "Driver group modules", "Drivers merged", "Registered at runtime"],
      data.providers.map((provider) => {
        const d = data.discovery.find((x) => x.provider === provider);
        const rows = data.rows.filter((r) => r.provider === provider);
        const index = d?.status === "loaded" ? `\`src/lib/providers/${provider}/drivers/index.ts\`` : "none";
        const groups = d && d.groups.length > 0 ? d.groups.map(code).join(", ") : "none";
        return [provider, index, groups, rows.length === 0 ? "none" : String(rows.length), rows.length === 0 ? "none" : String(rows.filter((r) => r.registered).length)];
      })
    ),
    ""
  );
  const missing = data.providers.filter((p) => !withDrivers.has(p));
  if (missing.length > 0) {
    push(
      `**No resource drivers are merged yet for:** ${missing.join(", ")}. Driver sets are delivered by separate workstreams and appear here once they are merged and this file is regenerated.`,
      ""
    );
  }
  const unregistered = data.rows.filter((r) => !r.registered);
  if (unregistered.length > 0) {
    push(
      `**${unregistered.length} merged driver${unregistered.length === 1 ? " is" : "s are"} registered by nothing.** They are code in the tree (a group module exports them, with the evidence each declares below), but no provider-level \`drivers/index.ts\` registers them, so \`getDriver()\` finds none of them at runtime and no operation can use them yet.`,
      ""
    );
  }
  push(
    "This matrix covers the **resource-driver** path (`src/lib/drivers`). The product engine's sandbox, LocalStack and AWS Preview providers use the older `ProviderAdapter` interface and have no per-operation evidence table; their honest status is in [`docs/LIMITATIONS.md`](../LIMITATIONS.md#providers).",
    ""
  );

  /* ------------------------------- driver matrix ----------------------------- */
  push("## Resource drivers: provider × native type × operation", "");
  if (data.rows.length === 0) {
    push("No resource driver is merged on this branch, so there are no rows. (The generator imports every `src/lib/providers/<provider>/drivers/index.ts` and every driver group module `drivers/<group>/index.ts` that exists; none does.)", "");
  } else {
    for (const provider of data.providers.filter((p) => withDrivers.has(p))) {
      push(`### ${provider}`, "");
      push(
        table(
          ["Native type", "Kind", "Driver", "Registered", ...CORE_OPERATIONS, "Day-two operations"],
          data.rows
            .filter((r) => r.provider === provider)
            .map((r) => [
              code(r.nativeType),
              code(r.kind),
              code(r.driverId),
              r.registered ? "yes" : "no",
              ...CORE_OPERATIONS.map((op) => coreCell(r.core[op])),
              r.operations.length === 0 ? "—" : r.operations.map((o) => `${code(o.capability)}: ${o.evidence === "undeclared" ? "**undeclared**" : code(o.evidence)}`).join("<br>"),
            ])
        ),
        ""
      );
    }
  }

  /* ------------------------------- observability ----------------------------- */
  push(
    "## Observability sources",
    "",
    "From `SOURCE_EVIDENCE` (`src/lib/observability/evidence.ts`). Sources are read-only query backends, not drivers.",
    "",
    table(
      ["Source", "Evidence", "What backs it"],
      data.sources.map((s) => [code(s.id), code(s.level), s.basis])
    ),
    ""
  );

  /* ------------------------------ capability catalog -------------------------- */
  push(
    "## Capability catalog",
    "",
    "From `CAPABILITIES` (`src/lib/capabilities/catalog.ts`): every name authorization can act on. **Default autonomy** is the minimum environment autonomy level at which the capability may run without a human approval, before policy ([ADR-0007](../adr/0007-capability-broker-and-autonomy.md), [POLICY.md](operations/POLICY.md)); `6` means never unattended. **Driver support** lists the providers whose merged drivers (registered or not) declare the capability as a native operation, at the *weakest* level among that provider's drivers. Many capabilities (planning, cost, placement, incident investigation) are not driver operations at all and will always read \"no driver\".",
    "",
    table(
      ["Capability", "Risk floor", "Mutates", "Flags", "Default autonomy", "Scope", "Driver support"],
      data.capabilities.map((c) => {
        const support = providerSupport(data.rows, c.name);
        const supportText =
          support.length === 0
            ? "no driver"
            : support.map((s) => `${s.provider}: ${s.weakest === "undeclared" ? "**undeclared**" : code(s.weakest)} (${s.drivers} driver${s.drivers === 1 ? "" : "s"})`).join("<br>");
        const flags = [c.destructive ? "destructive" : "", c.escapeHatch ? "escape hatch" : ""].filter(Boolean).join(", ") || "—";
        return [code(c.name), c.risk, c.mutates ? "yes" : "no", flags, AUTONOMY_LABEL[c.defaultAutonomy] ?? String(c.defaultAutonomy), c.scopeLevel, supportText];
      })
    ),
    "",
    "### Mutating capabilities by default autonomy",
    "",
    "A mutating capability with default autonomy N needs no approval *for autonomy reasons* only in an environment whose autonomy level is at least N; every other policy rule can still require or deny ([POLICY.md](operations/POLICY.md)).",
    "",
    table(
      ["Default autonomy", "Mutating capabilities"],
      [0, 1, 2, 3, 4, 5, 6].map((level) => {
        const names = data.capabilities.filter((c) => c.mutates && c.defaultAutonomy === level).map((c) => code(c.name));
        return [AUTONOMY_LABEL[level] ?? String(level), names.length === 0 ? "—" : names.join(", ")];
      })
    ),
    "",
    "Non-mutating capabilities are not gated by autonomy: the policy rule `autonomy_below_capability` applies to mutating capabilities only.",
    ""
  );

  /* --------------------------------- problems -------------------------------- */
  push("## Problems", "");
  if (data.problems.length === 0) push("None: every merged driver's declaration is consistent with its shape.", "");
  else {
    push("Each line is an inconsistency between a driver's declaration and its shape. Fix the driver; do not edit this file.", "");
    for (const p of data.problems) push(`- ${code(p.driver)} ${p.message}.`);
    push("");
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ----------------------------------- CLI ---------------------------------- */

export async function renderCurrentMatrix(options: { repoRoot?: string } = {}): Promise<{ data: MatrixData; text: string }> {
  const data = await collectMatrix(options);
  return { data, text: renderMatrix(data) };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(" ")}\nUsage: npx tsx scripts/docs/capability-matrix.ts [--check]\n`);
    return 2;
  }
  const repoRoot = defaultRepoRoot();
  const target = path.join(repoRoot, MATRIX_RELATIVE_PATH);
  const { data, text } = await renderCurrentMatrix({ repoRoot });
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : undefined;

  for (const p of data.problems) process.stderr.write(`problem: ${p.driver} ${p.message}\n`);

  if (args.includes("--check")) {
    if (current !== text) {
      process.stderr.write(`${MATRIX_RELATIVE_PATH} is out of date. Run: npx tsx scripts/docs/capability-matrix.ts\n`);
      return 1;
    }
    if (data.problems.length > 0) return 1;
    process.stdout.write(`${MATRIX_RELATIVE_PATH} is up to date.\n`);
    return 0;
  }
  if (current === text) {
    process.stdout.write(`${MATRIX_RELATIVE_PATH} already up to date.\n`);
    return 0;
  }
  fs.writeFileSync(target, text, "utf8");
  process.stdout.write(`Wrote ${MATRIX_RELATIVE_PATH} (${text.split("\n").length - 1} lines, ${data.rows.length} driver rows).\n`);
  return 0;
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string => path.resolve(p).replace(/\.(ts|js|cjs|mjs)$/, "").toLowerCase();
  return normalize(entry) === normalize(__filename);
};

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    }
  );
}
