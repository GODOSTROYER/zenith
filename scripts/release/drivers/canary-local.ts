/**
 * PROD-OPS-06 local rehearsal: a raw-byte scan of an owned J1 stack's persistence for one canary value.
 *
 * Docker Desktop keeps its data root inside its own VM, so the scan works per owned resource instead: every volume the
 * stack owns (scripts/acceptance/default-stack/config.mjs `owns`) through a read-only throwaway container, every owned
 * container's log stream, and the stack directory on the host. A control volume holding the canary proves the volume
 * scan can see it. The canary reaches grep only through a 0600 pattern file, never argv, logs or evidence; results
 * name places and counts, never paths or content.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { owns } from "../../acceptance/default-stack/config.mjs";

export interface LocalCanaryScan { control: boolean; scanned: Record<string, number>; leaks: Record<string, number>; leakingVolumes: string[] }
type Run = (argv: string[], input?: Buffer) => Promise<{ code: number | null; stdout: string }>;
/** A pinned, already-local image for the read-only volume reads (the one the stack's own staging uses is not assumed). */
export const SCAN_IMAGE = "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f";

const run: Run = (argv, input) => new Promise((resolve, reject) => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 1_000_000) child.kill("SIGKILL"); });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout }));
  child.stdin.end(input);
});

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** The stack's own volumes and containers, by label, as its cleanup selects them. */
async function ownedResources(state: { installationId: string; applicationInstallationId?: string; projectId: string }, exec: Run) {
  const labelsOf = async (kind: "volume" | "container", ids: string[]): Promise<{ id: string; labels: Record<string, string> }[]> =>
    ids.length ? (JSON.parse((await exec(["docker", kind === "volume" ? "volume" : "container", "inspect", ...ids])).stdout) as { Name?: string; Id?: string; Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } }[])
      .map((item) => ({ id: (kind === "volume" ? item.Name : item.Id)!, labels: (kind === "volume" ? item.Labels : item.Config?.Labels) ?? {} })) : [];
  const volumes = (await labelsOf("volume", lines((await exec(["docker", "volume", "ls", "-q"])).stdout))).filter((v) => owns(v.labels, state)).map((v) => v.id);
  const containers = (await labelsOf("container", lines((await exec(["docker", "ps", "-aq"])).stdout))).filter((c) => owns(c.labels, state)).map((c) => c.id);
  return { volumes, containers };
}

/** Files under a volume that contain the pattern, read through a throwaway read-only container. */
async function volumeHits(volume: string, patternDir: string, exec: Run): Promise<number> {
  const result = await exec(["docker", "run", "--rm", "--network", "none", "--read-only", "-v", `${volume}:/v:ro`, "-v", `${patternDir}:/p:ro`, SCAN_IMAGE, "grep", "-rlaF", "-f", "/p/pattern", "/v"]);
  if (result.code !== 0 && result.code !== 1) throw new Error("canary-scan:volume-read-failed");
  return lines(result.stdout).length;
}

export async function scanStackForCanary(canary: string, stack: { directory: string; state: { installationId: string; applicationInstallationId?: string; projectId: string } }, exec: Run = run): Promise<LocalCanaryScan> {
  if (!/^[A-Za-z0-9]{24,128}$/.test(canary)) throw new Error("canary-scan:canary-shape");
  const patternDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-ops06-pattern-"));
  const pattern = path.join(patternDir, "pattern");
  fs.writeFileSync(pattern, canary, { mode: 0o600 });
  fs.chmodSync(patternDir, 0o755);
  const control = `zenith-ops06-control-${process.pid}-${Date.now()}`;
  const leakingVolumes: string[] = [];
  const leaks: Record<string, number> = {}, scanned: Record<string, number> = { volumes: 0, "container logs": 0, "stack directory": 1 };
  try {
    // Control: a volume with the canary in one file must be found by the same read.
    await exec(["docker", "volume", "create", control]);
    const write = await exec(["docker", "run", "--rm", "--network", "none", "-i", "-v", `${control}:/v`, SCAN_IMAGE, "sh", "-c", "cat > /v/control"], Buffer.from(canary));
    const controlFound = write.code === 0 && await volumeHits(control, patternDir, exec) === 1;
    const { volumes, containers } = await ownedResources(stack.state, exec);
    for (const volume of volumes) {
      scanned.volumes!++;
      const hits = await volumeHits(volume, patternDir, exec);
      if (hits) { leaks["docker volumes"] = (leaks["docker volumes"] ?? 0) + hits; leakingVolumes.push(volume); }
    }
    for (const container of containers) {
      scanned["container logs"]!++;
      // Both log streams, counted by grep: the id is a hex container id from docker itself, the canary stays in the file.
      if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error("canary-scan:container-id");
      const logs = await exec(["sh", "-c", `docker logs ${container} 2>&1 | grep -caF -f "$0"`, pattern]);
      if (Number(logs.stdout.trim()) > 0) leaks["container logs"] = (leaks["container logs"] ?? 0) + 1;
    }
    const host = await exec(["grep", "-rlaF", "-f", pattern, stack.directory]);
    if (host.code !== 0 && host.code !== 1) throw new Error("canary-scan:stack-directory-read-failed");
    if (lines(host.stdout).length) leaks["stack directory"] = lines(host.stdout).length;
    return { control: controlFound, scanned, leaks, leakingVolumes };
  } finally {
    await exec(["docker", "volume", "rm", "-f", control]).catch(() => undefined);
    fs.rmSync(patternDir, { recursive: true, force: true });
  }
}
