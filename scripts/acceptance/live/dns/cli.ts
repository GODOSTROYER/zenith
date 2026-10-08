import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Packet, Permissions, planner, type Provider } from "./contracts";
import { Guard } from "./guard";
import { livePort, run } from "./runtime";
import { requireScope } from "../../../release/scope";

export async function main(provider: Provider, args = process.argv.slice(2), env: Readonly<Record<string, string | undefined>> = process.env, dns = false): Promise<number> {
  let outputFd: number | undefined;
  try {
    if (args.some((a) => a.startsWith("--") && !["--plan", "--cleanup", "--packet", "--permissions", "--out"].includes(a))) throw new Error("Unknown option");
    const option = (name: string) => {
      const i = args.indexOf(name);
      if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Required file option is missing");
      return args[i + 1];
    };
    const packet = Packet.parse(JSON.parse(readFileSync(option("--packet"), "utf8")));
    if (packet.provider !== provider) throw new Error("Wrong provider packet");
    const plan = planner(packet);
    if (args.includes("--plan")) { process.stdout.write(JSON.stringify(plan, null, 2) + "\n"); return 0; }
    const P = provider.toUpperCase();
    if (env[`ZENITH_LIVE_${P}`] !== "1" || (dns && env.ZENITH_LIVE_DNS !== "1")) {
      process.stdout.write(`NOT RUN: requires ZENITH_LIVE_${P}=1${dns ? " and ZENITH_LIVE_DNS=1" : ""}; live acceptance deferred\n`);
      return 3;
    }
    const credentialFile = env[`ZENITH_LIVE_${P}_CREDENTIAL_FILE`];
    const tokenFile = env.ZENITH_LIVE_API_TOKEN_FILE;
    if (!credentialFile || !tokenFile) throw new Error("Credential FILE references are required");
    const permissions = Permissions.parse(JSON.parse(readFileSync(option("--permissions"), "utf8")));
    // This observer reads clouds and requests the existing human-approved destroy
    // path. Both the root scope and exact L2 packet envelope govern those actions.
    const scope = requireScope("non-aws-dns-live", provider, env);
    scope.assertGrant("non-aws-dns-live", "control_plane", "read");
    scope.assertGrant("non-aws-dns-live", "control_plane", "teardown_run_tagged");
    const guard = new Guard(packet, permissions, undefined, scope);
    if (process.versions.node.split(".")[0] !== "22") throw new Error("Node 22 is required");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (sha !== packet.commit || execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
      throw new Error("Evidence requires a clean checkout at the packet commit");
    const out = option("--out");
    if (existsSync(out)) throw new Error("Evidence destination exists; use a fresh path");
    // Validate all destinations before credentials are opened or any request is attempted.
    for (const d of packet.inventory) {
      guard.url(d.url, "cloud");
      if (d.parentOwnership) guard.url(d.parentOwnership.url, "cloud");
    }
    for (const c of packet.checks) for (const p of c.probes) {
      if (p.kind === "control") guard.url(new URL(p.path, packet.apiOrigin).href, "control");
      else if (p.kind === "dns") guard.dns(p.name);
      else guard.url(p.url, p.kind === "cloud" ? "cloud" : "traffic");
    }
    outputFd = openSync(out, "wx", 0o600);
    const cancelled = { value: false };
    const stop = () => { cancelled.value = true; process.stdout.write("Cancellation requested; entering bounded teardown and leak scan\n"); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try {
      const port = livePort(guard, credentialFile, tokenFile, (s) => process.stdout.write(s + "\n"));
      const report = await run(packet, guard, port, args.includes("--cleanup"), () => cancelled.value);
      writeFileSync(outputFd, JSON.stringify(report, null, 2) + "\n");
      process.stdout.write(`Live checks: ${report.result}; leak scan: ${report.cleanup.leakScan}\n`);
      return report.result === "passed_checks" ? 0 : 1;
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } catch {
    // Never expose credential paths, response bodies, raw SDK errors or failed assertions.
    process.stderr.write("Live acceptance refused or failed; review the packet, permissions and required FILE references locally\n");
    return 2;
  } finally { if (outputFd !== undefined) closeSync(outputFd); }
}
