import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { manifestDigestOf } from "@/lib/plugins/manifest";
import { type LaunchInput } from "@/cli/plugins/launcher";
import { tokenDigest, type LaunchBinding, type LaunchLease } from "@/cli/plugins/authority";
import { type ContainerRuntime, type SandboxSpec } from "@/cli/plugins/runtime";
import { baseManifest, makePublisher, signManifest } from "./support";

export function archive(entries: { name: string; content?: string; type?: string; link?: string }[] = [{ name: "main.mjs", content: "setInterval(() => {}, 1000);" }]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512); const content = Buffer.from(entry.content ?? "");
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156); if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257); header.write("00", 263);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function launchFixture(bytes = archive()) {
  const publisher = makePublisher();
  const manifest = signManifest(baseManifest({
    artifact: { format: "tar.gz", url: "https://releases.example.test/plugin.tgz", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
    components: { mcpServers: [{ name: "zenith", transport: "stdio", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/main.mjs"], env: { ZENITH_API_VERSION: "3" } }] },
  }), publisher.privateKey);
  const input: LaunchInput = { manifest, reviewedDigest: manifestDigestOf(manifest), registrationId: "plugin-a", workspaceId: "ws-a",
    apiOrigin: "https://zenith.example.test", token: `za_${randomBytes(32).toString("base64url")}`, image: `node@sha256:${createHash("sha256").update("fixture image reference only").digest("hex")}`, server: "zenith" };
  const binding: LaunchBinding = { manifestDigest: input.reviewedDigest, registrationId: input.registrationId,
    workspaceId: input.workspaceId, credentialDigest: tokenDigest(input.token), audience: `${input.apiOrigin}/api/agent/v3/mcp` };
  const lease: LaunchLease = { ...binding, status: "active", credentialKind: "plugin_scoped_za", projectIds: ["proj-a"], environmentIds: ["env-a"], tools: ["zenith_get_topology"], scopes: ["read"], expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { publisher, bytes, manifest, input, binding, lease };
}

/** Contract-only container model. No Docker or actual isolation is claimed. */
export class FakeContainerRuntime implements ContainerRuntime {
  specs: SandboxSpec[] = [];
  stops = 0;
  failStart = false;
  failStop = false;
  private done: ((code: number) => void) | undefined;
  exit(code = 0): void { this.done?.(code); }
  async start(spec: SandboxSpec) {
    this.specs.push(spec);
    if (this.failStart) throw new Error("modeled startup failure");
    const wait = new Promise<number>((resolve) => { this.done = resolve; });
    return { wait: () => wait, stop: async () => { this.stops++; if (this.failStop) throw new Error("modeled removal failure"); this.exit(); } };
  }
}
