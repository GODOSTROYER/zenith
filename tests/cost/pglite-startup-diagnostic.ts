// Read-only diagnostic: no timeout changes, prewarming, or test substitutions.
import { availableParallelism, freemem } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

async function main() {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  async function phase<T>(name: string, body: () => Promise<T>): Promise<T> {
    const wall = performance.now(), cpu = process.cpuUsage();
    const result = await body();
    const elapsed = process.cpuUsage(cpu);
    console.log(JSON.stringify({ phase: name, wallMs: Math.round(performance.now() - wall), cpuMs: Math.round((elapsed.user + elapsed.system) / 1000), lagMaxMs: Math.round(lag.max / 1e6), freeMiB: Math.round(freemem() / 1048576), cpus: availableParallelism() }));
    lag.reset();
    return result;
  }
  const { openPlatformDb } = await phase("import-open", () => import("../../src/lib/controlplane/db/open"));
  const { migratePlatformDb } = await phase("import-migrator", () => import("../../src/lib/controlplane/db/migrator"));
  for (let i = 1; i <= 2; i++) {
    const db = await phase(`engine-${i}`, () => openPlatformDb({ kind: "pglite", migrate: false }));
    try {
      await phase(`migrations-${i}`, () => migratePlatformDb(db));
      await phase(`query-${i}`, () => db.query("select 1 as ready"));
    } finally { await db.close(); }
  }
  lag.disable();
}
void main().catch(() => { console.error("PGlite diagnostic failed."); process.exitCode = 1; });
