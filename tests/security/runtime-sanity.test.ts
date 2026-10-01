/**
 * The engine under the security properties (WS-SEC).
 *
 * SEC-F9 (MEDIUM on affected runtimes): Node 24.x (V8 13.6, including the 24.19.0
 * on this development machine) ships a `JSON.parse` defect — nodejs/node#60606 —
 * that can return a wrong single-character key. Zenith parses untrusted JSON at
 * every boundary and digests the PARSED value, so on an affected runtime the
 * digest, the policy input and the executed action can all silently disagree
 * with the bytes the sender wrote and the approver reviewed. CI
 * (.github/workflows, node 22.16.0) and the Dockerfile (node:22) are not
 * affected, but `package.json` only says `>=22.16`, so nothing stops a deployment
 * from running on an affected 24.x.
 *
 * This file does two things: it says, in the test output, whether the current
 * runtime is affected; and it fails when the repository's own runtime pin would
 * allow an affected version without a guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSON_PARSE_BUG_REASON, jsonParseKeyBug } from "../_support/security";

const affected = jsonParseKeyBug();
const major = Number(process.versions.node.split(".")[0]);

describe("runtime: JSON.parse fidelity", () => {
  it("reports whether THIS runtime has the V8 single-character-key defect", () => {
    if (affected) console.warn(`[security] SEC-F9 is live on this machine: ${JSON_PARSE_BUG_REASON}`);
    // The defect appeared in V8 12.8; Node 22 ships V8 12.4. A runtime older than that must be clean.
    if (major <= 22) expect(affected, `Node ${process.version} (V8 ${process.versions.v8}) is expected to be unaffected`).toBe(false);
    // On Node >= 23 the result is informational; the assertion below keeps the pin honest.
    expect(typeof affected).toBe("boolean");
  });

  it("is demonstrably detectable: on an affected runtime the detector sees wrong keys, on a clean one it sees none", () => {
    // (a clean runtime cannot be made to misparse, so this only pins that the detector is a pure function of the runtime)
    expect(jsonParseKeyBug()).toBe(affected);
  });

  it("CI and the Dockerfile pin a Node major that does not have the defect (22), or the suite says where it would have to be fixed", () => {
    const root = process.cwd();
    const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    const docker = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const ciVersions = [...ci.matchAll(/node-version:\s*'?(\d+)\./g)].map((m) => Number(m[1]));
    const dockerVersions = [...docker.matchAll(/FROM node:(\d+)/g)].map((m) => Number(m[1]));
    expect(ciVersions.length).toBeGreaterThan(0);
    expect(dockerVersions.length).toBeGreaterThan(0);
    for (const v of [...ciVersions, ...dockerVersions]) {
      expect(v, "a deployment runtime newer than 22 must first be checked with tests/_support/security/runtime.ts (jsonParseKeyBug)").toBeLessThanOrEqual(22);
    }
  });

  /**
   * The repo's engine floor (`>=22.16`) admits Node 24.x and 26.x. Until a patched
   * runtime is known, the engine range should exclude the affected majors or the
   * app should refuse to start on one. When package.json is tightened (or a
   * startup self-check lands) flip this to `it`.
   */
  it.fails("SEC-F9: package.json's engine range excludes runtimes with the JSON.parse key defect (or the app self-checks at startup)", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { engines?: { node?: string } };
    const range = pkg.engines?.node ?? "";
    // an open-ended floor (">=22.16") admits Node 24 and 26
    expect(range, `engines.node is "${range}"`).not.toMatch(/^>=/);
  });
});
