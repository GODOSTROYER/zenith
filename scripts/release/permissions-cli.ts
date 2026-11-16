/**
 * `npx tsx scripts/release/permissions-cli.ts <show|check|approve>` (PROD-REL-04).
 *
 * show     print the manifest, its content digest and the approval state.
 * check    exit 0 only when a person's approval is current (used by operators and the orchestrator).
 * approve  a PERSON pins the current content digest. Requires an interactive terminal and the
 *          digest prefix typed back; refuses in a pipe or CI so no script can approve for you.
 */
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { contentDigest, defaultManifestPath, loadManifestFile, Scope, ScopeError } from "./scope";

const USAGE = "usage: permissions-cli <show|check|approve --by <name> [--days <n>]>";

interface Io { out: (s: string) => void; err: (s: string) => void }

export async function runPermissionsCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Io = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } },
  interactive: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask?: (prompt: string) => Promise<string>,
): Promise<number> {
  const [command, ...rest] = argv;
  const file = defaultManifestPath(env);
  try {
    if (command === "show" || command === "check") {
      const manifest = loadManifestFile(file);
      const scope = new Scope(manifest);
      if (command === "show") {
        io.out(`${JSON.stringify({ file, contentDigest: scope.digest, approval: manifest.approval, budgets: manifest.budgets, harnesses: Object.keys(manifest.harnesses) }, null, 2)}\n`);
        return 0;
      }
      scope.assertApproved();
      io.out(`approved by ${manifest.approval.approvedBy} (digest ${scope.digest.slice(0, 12)})\n`);
      return 0;
    }
    if (command === "approve") {
      const byIndex = rest.indexOf("--by");
      const by = byIndex >= 0 ? rest[byIndex + 1] : undefined;
      if (!by || by.startsWith("--")) { io.err(`${USAGE}\n`); return 2; }
      const daysIndex = rest.indexOf("--days");
      const days = daysIndex >= 0 ? Number(rest[daysIndex + 1]) : 14;
      if (!Number.isInteger(days) || days < 1 || days > 90) { io.err("--days must be a whole number from 1 to 90.\n"); return 2; }
      if (!interactive) { io.err("Approval needs an interactive terminal: a person must read the scope and type the digest. Refusing.\n"); return 2; }
      const manifest = loadManifestFile(file);
      const wanted = contentDigest(manifest);
      io.out(`${JSON.stringify({ budgets: manifest.budgets, harnesses: manifest.harnesses, forbiddenActions: manifest.forbiddenActions }, null, 2)}\n`);
      const prompt = `Type the first 12 characters of the digest (${wanted.slice(0, 12)}) to approve this exact scope: `;
      let typed: string;
      if (ask) typed = (await ask(prompt)).trim();
      else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        typed = (await rl.question(prompt)).trim();
        rl.close();
      }
      if (typed !== wanted.slice(0, 12)) { io.err("Digest did not match; nothing was approved.\n"); return 1; }
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const now = new Date();
      const approval = { status: "approved", approvedBy: by, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(), approvedDigest: wanted };
      raw.approval = approval;
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      io.out(`Approved by ${by} until ${approval.expiresAt}.\n`);
      return 0;
    }
    io.err(`${USAGE}\n`);
    return 2;
  } catch (error) {
    io.err(`${error instanceof ScopeError ? `REFUSED (${error.code}): ` : ""}${error instanceof Error ? error.message : "unexpected error"}\n`);
    return error instanceof ScopeError ? 1 : 2;
  }
}

if (process.argv[1] && /(?:^|[/\\])permissions-cli\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) {
  void runPermissionsCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
