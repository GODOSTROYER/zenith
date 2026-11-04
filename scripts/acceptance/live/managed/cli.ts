import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { loadScope, loadManifestFile, defaultManifestPath, ScopeError } from "../../../release/scope";
import { buildPlan, planSummary, scenarios, type Recipe } from "./plan";
import { Approval, fileJournal, reserveBudget, runPlan } from "./runner";
import { privateFile, realTransport } from "./transport";

type Env = Readonly<Record<string, string | undefined>>;
/** An explicitly incomplete owner-editable recipe. No cloud/account creation or price verification is implied. */
export function template(profile: Recipe["profile"], sourceCommit: string, now: Date = new Date()): Recipe {
  const runId = `zlive-${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
  const scenario = scenarios(profile)[0]!;
  const namespace = `zenith-${runId}-tenant-a`;
  const ownership = { kind: "kubernetes" as const, target: "cluster", resource: "namespace" as const, name: namespace, assertions: [{ pointer: "/metadata/name", equals: namespace }] };
  return {
    schema: 1, profile, runId, sourceCommit, startedAt: now.toISOString(), ttlMinutes: 60,
    estimate: { byProviderUsd: { kubernetes: 1, control_plane: 0 }, cleanupReserveUsd: 1, provisional: true, basis: "PLACEHOLDER: replace with owner-reviewed provider prices for the run window, including DNS, volumes, database, traffic and idle resources. Existing cluster cost is not free." },
    targets: [
      { id: "product", kind: "product", provider: "control_plane", account: "owned-sandbox", region: "owned-region", origin: "https://zenith.invalid", credentialRef: "ZENITH_L3_BROWSER_FILE", auth: "browser", workspaceId: "replace-disposable-workspace" },
      { id: "cluster", kind: "kubernetes", provider: "kubernetes", account: "replace-owned-account", region: "replace-owned-region", origin: "https://cluster.invalid", credentialRef: "ZENITH_L3_KUBECONFIG_FILE", context: "replace-managed-context", auth: "none" },
    ],
    resources: [{ id: "tenant-a", target: "cluster", name: namespace, ownership, tagPointer: "/metadata/annotations/zenith:live-run", ttlPointer: "/metadata/annotations/zenith:ttl-expires" }],
    steps: [{ id: "observe-operation", scenario, action: "read", request: { kind: "http", target: "product", method: "GET", path: "/api/platform/v1/operations/replace-owned-operation", status: 200, assertions: [{ pointer: "/operation/status", equals: "succeeded" }] }, attempts: 5, intervalMs: 1000 }],
    cleanup: [{ id: "remove-tenant-a", scenario, action: "teardown_run_tagged", resource: "tenant-a", request: { kind: "delete_namespace", target: "cluster", name: namespace }, attempts: 1, intervalMs: 1000 }],
    scans: [{ id: "scan-cluster", scenario, action: "read", request: { kind: "inventory", target: "cluster" }, attempts: 60, intervalMs: 1000 }],
  };
}

export async function cli(argv: readonly string[], env: Env = process.env): Promise<number> {
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Node 22 is required");
  const args = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["--plan", "--run", "--template", "--cleanup-only"].includes(arg)) flags.add(arg);
    else if (["--profile", "--fixture"].includes(arg) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) args.set(arg, argv[++i]!);
    else throw new Error("Usage: --profile managed|mixed|release --template|--plan|--run|--cleanup-only [--fixture FILE]");
  }
  if (flags.size !== 1) throw new Error("Select exactly one mode; --plan is credential-free");
  const profile = args.get("--profile") ?? "managed";
  if (!["managed", "mixed", "release"].includes(profile)) throw new Error("Unknown profile");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (flags.has("--template")) { process.stdout.write(`${JSON.stringify(template(profile as Recipe["profile"], sourceCommit), null, 2)}\n`); return 0; }
  const fixture = args.get("--fixture");
  if (!fixture && !flags.has("--plan")) throw new Error("Live execution requires an exact owner-reviewed recipe FILE");
  const plan = buildPlan(fixture ? JSON.parse(readFileSync(fixture, "utf8")) : template(profile as Recipe["profile"], sourceCommit));
  if (plan.profile !== profile) throw new Error("Recipe belongs to another profile");
  const manifest = loadManifestFile(defaultManifestPath(env));
  if (flags.has("--plan")) { process.stdout.write(`${JSON.stringify(planSummary(plan, manifest), null, 2)}\n`); return 0; }
  if (plan.estimate.basis.startsWith("PLACEHOLDER") || JSON.stringify(plan).includes("replace-") || plan.targets.some(t => t.origin?.includes(".invalid"))) throw new Error("Owner fixture and real price projection are incomplete");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Live evidence requires a clean, committed verifier checkout");
  // Gate and scope precede credential reads, even the exact-plan approval record.
  const gate = `ZENITH_LIVE_${profile === "managed" ? "MANAGED" : profile === "mixed" ? "MIXED" : "RELEASE"}`;
  if (env[gate] !== "1") throw new Error("Live acceptance is deferred; set the explicit profile gate on the Mac after DEC-CLOUD");
  const scope = loadScope(defaultManifestPath(env)); scope.assertApproved();
  const approval = Approval.parse(JSON.parse(readFileSync(privateFile("ZENITH_L3_APPROVAL_FILE", env), "utf8")));
  const budget = env.ZENITH_LIVE_BUDGET_FILE ?? env.ZENITH_L3_BUDGET_FILE;
  if (!budget || !path.isAbsolute(budget)) throw new Error("Use one absolute owner budget FILE across all live jobs");
  const out = path.resolve(env.ZENITH_L3_OUT ?? ".data-live/l3", plan.runId);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // One process per run. Crash locks remain visible for an owner to audit, never silently removed.
  const lock = path.join(out, "run.lock"); writeFileSync(lock, "L3 run in progress\n", { flag: "wx", mode: 0o600 });
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const report = await runPlan(plan, { env, scope, approval, sourceCommit, signal: controller.signal, cleanupOnly: flags.has("--cleanup-only"),
      transport: () => realTransport(env, plan.runId, plan.targets, scope), journal: fileJournal(path.join(out, "journal.json")), reserve: () => reserveBudget(budget, plan, scope),
    });
    writeFileSync(path.join(out, flags.has("--cleanup-only") ? "cleanup-report.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.counts.failed ? 1 : report.ok ? 0 : 3;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); if (existsSync(lock)) unlinkSync(lock); }
}
if (process.argv[1] && /(?:^|[/\\])cli\.(?:ts|js)$/.test(process.argv[1])) void cli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`REFUSED: ${error instanceof ScopeError ? error.code : "plan, gate, fixture or permission validation failed"}. No approval or privileged fallback was attempted.\n`); process.exitCode = 2;
});
