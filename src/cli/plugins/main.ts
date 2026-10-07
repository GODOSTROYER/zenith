import { open } from "node:fs/promises";
import { trustedPublishersFromEnv } from "@/lib/plugins/manifest";
import { readStdin } from "../input";
import { LauncherError } from "./authority";
import { launchPlugin } from "./launcher";
import { DockerRuntime } from "./runtime";

export const PLUGIN_HELP = `zenith plugin run --manifest FILE --digest REVIEWED_SHA256 --registration ID
  --workspace ID --url HTTPS_ORIGIN --image NAME@sha256:DIGEST --server NAME
  [--ca-file FILE]
Reads only a dedicated scoped za_ token from stdin. Does not use saved login or
ZENITH_TOKEN. Trusted publishers: ZENITH_PLUGIN_TRUSTED_PUBLISHERS.
Requires the platform launch/check authority join; absent authority refuses.
Direct entry: npx --no-install tsx src/cli/plugins/bin.ts plugin run ...
`;

/** Integration seam for src/cli/main.ts: dispatch the plugin command here.
 * The direct executable already calls this exact production implementation. */
export async function runPluginCli(argv: string[], runtime: {
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
} = {}): Promise<number> {
  const stdout = runtime.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = runtime.stderr ?? ((s: string) => process.stderr.write(s));
  if (argv.length === 1 && argv[0] === "--help") { stdout(PLUGIN_HELP); return 0; }
  try {
    if (argv[0] !== "plugin" || argv[1] !== "run") throw new LauncherError("invalid_plugin_arguments");
    const flags: Record<string, string> = {};
    const allowed = ["manifest", "digest", "registration", "workspace", "url", "image", "server", "ca-file"];
    for (let index = 2; index < argv.length; index += 2) {
      const key = argv[index].slice(2); const value = argv[index + 1];
      if (!argv[index].startsWith("--") || !allowed.includes(key) || flags[key] || !value || value.startsWith("--")) throw new LauncherError("invalid_plugin_arguments");
      flags[key] = value;
    }
    if (allowed.slice(0, -1).some((key) => !flags[key])) throw new LauncherError("invalid_plugin_arguments");
    const file = await open(flags.manifest, "r");
    let data: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new LauncherError("manifest_too_large");
      const buffer = Buffer.alloc(65_537); let size = 0;
      while (size < buffer.length) {
        const part = await file.read(buffer, size, buffer.length - size, null);
        if (!part.bytesRead) break; size += part.bytesRead;
      }
      if (size > 65_536) throw new LauncherError("manifest_too_large");
      data = buffer.subarray(0, size);
    } finally { await file.close(); }
    const token = (await readStdin(runtime.stdin ?? process.stdin, runtime.signal, 256)).trim();
    const result = await launchPlugin({
      manifest: JSON.parse(data.toString("utf8")) as unknown, reviewedDigest: flags.digest,
      registrationId: flags.registration, workspaceId: flags.workspace, apiOrigin: flags.url,
      token, image: flags.image, server: flags.server, caFile: flags["ca-file"],
    }, { publishers: trustedPublishersFromEnv(runtime.env), runtime: new DockerRuntime(), signal: runtime.signal });
    stdout(JSON.stringify({ exitCode: result.exitCode }) + "\n");
    return result.exitCode === 0 ? 0 : 1;
  } catch (error) {
    // Never echo remote errors, manifest contents, plugin output or token input.
    stderr(JSON.stringify({ code: error instanceof LauncherError ? error.code : "plugin_launch_refused" }) + "\n");
    return runtime.signal?.aborted ? 130 : 1;
  }
}
