/**
 * Operated rehearsals: recreate an owned J1 stack's API with extra environment values (for example a run-scoped CRON_SECRET
 * or the operator ids that may use /api/admin/ops), and put the original composition back afterwards. The same rewrite
 * scripts/acceptance/live/product/ops-02-stack.ts makes on the runner. Values go only into the private 0600 composition
 * file, never argv, logs or evidence.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compose, docker, readState } from "../../acceptance/default-stack/runtime.mjs";

type State = ReturnType<typeof readState> & { directory: string; applicationInstallationId?: string; compositionSha256?: string };

async function healthyApi(state: State): Promise<void> {
  for (const deadline = Date.now() + 360_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 5_000))) {
    const id = String(await compose(state, ["ps", "-q", "api"])).trim();
    if (!id) continue;
    const [item] = JSON.parse(String(await docker(["inspect", id]))) as { Config: { Labels?: Record<string, string> }; State: { Health?: { Status?: string } } }[];
    if (item?.Config.Labels?.["io.zenith.installation"] === state.applicationInstallationId && item.State.Health?.Status === "healthy") return;
  }
  throw new Error("stack-env:api-not-healthy");
}

/** Recreates the API with `extra` added to its environment. `restore()` writes the original bytes back and recreates it again. */
export async function withApiEnvironment(directory: string, extra: Record<string, string>): Promise<{ restore(): Promise<void> }> {
  const original = readState(directory) as State;
  const file = path.join(original.directory, "installation", "stack.compose.json");
  const originalBytes = readFileSync(file);
  const recreate = async (bytes: Buffer): Promise<void> => {
    writeFileSync(file, bytes, { mode: 0o600 });
    const active = { ...original, compositionSha256: createHash("sha256").update(bytes).digest("hex") };
    await compose(active, ["up", "-d", "--no-deps", "api"]);
    await healthyApi(active);
  };
  const document = JSON.parse(originalBytes.toString("utf8")) as { services: Record<string, { environment?: Record<string, string> }> };
  document.services.api!.environment = { ...document.services.api!.environment, ...extra };
  await recreate(Buffer.from(JSON.stringify(document)));
  let restored = false;
  return { async restore() { if (restored) return; restored = true; await recreate(originalBytes); } };
}
