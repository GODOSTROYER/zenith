#!/usr/bin/env node
/** Offline owner sign-off. prepare never signs; sign requires a terminal and an exact digest acknowledgement. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { canonical, releaseSnapshotDigest, selectReleaseEvidence, sha256, SIGNOFF_FORMAT, signSignoff } from "./status.mjs";

export async function main(argv, root = process.cwd()) {
  const [command, ...args] = argv;
  const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
    if (!value("--out")) throw new Error("--out is required");
    const ledger = JSON.parse(readFileSync(`${root}/docs/build/production/ledger.json`, "utf8"));
    const selection = selectReleaseEvidence(ledger, { root });
    if (selection.errors.length) throw new Error(selection.errors.join("\n"));
    if (command === "prepare") {
      if (!value("--who")) throw new Error("--who is required");
      const body = { format: SIGNOFF_FORMAT, who: value("--who"), when: new Date().toISOString(), commit: ledger.releaseCandidate.commit,
        scope: { status: "productionApproved", requirements: ledger.requirements.map((r) => r.id).sort() }, ledgerSha256: releaseSnapshotDigest(ledger), evidence: selection.refs };
      writeFileSync(value("--out"), `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      process.stdout.write("Unsigned review draft created. This is not sign-off or release evidence.\n");
      return 0;
    }
    if (command !== "sign" || !value("--draft") || !value("--seed-file") || !value("--kid")) throw new Error("usage: prepare --who IDENTITY --out FILE | sign --draft FILE --seed-file FILE --kid KID --out FILE");
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Accountable sign-off requires an interactive human terminal");
    const body = JSON.parse(readFileSync(value("--draft"), "utf8"));
    if (body.ledgerSha256 !== releaseSnapshotDigest(ledger) || canonical(body.evidence) !== canonical(selection.refs)) throw new Error("Review draft is stale; prepare it again");
    const digest = sha256(canonical(body));
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await terminal.question(`Approve production scope as ${body.who}. Type ${digest}: `); }
    finally { terminal.close(); }
    if (answer !== digest) throw new Error("Sign-off declined");
    const encoded = readFileSync(value("--seed-file"), "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Seed file must contain one base64url Ed25519 seed");
    const seed = Buffer.from(encoded, "base64url");
    try { writeFileSync(value("--out"), `${JSON.stringify(signSignoff(body, seed, value("--kid")), null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
    finally { seed.fill(0); }
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Sign-off refused"}\n`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
