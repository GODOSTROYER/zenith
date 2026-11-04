/** Genuine kind/LocalStack traffic and independent PostgreSQL readback. */
import { spawn } from "node:child_process";
import { command, kubeArgs, composeArgs, assertLocalCluster, assertLocalDocker, waitFor, setupLambda, type LocalState } from "./local-environment";
import { NAMESPACE } from "./local-kubernetes";
import { runTraffic, type TrafficLedger } from "../acceptance/mixed/traffic";
import { verifyReadback, type StoredOrder } from "../acceptance/mixed/readback";
import type { LocalReceipt } from "./local-targets";

export async function mixedRehearsal(state: LocalState, recovery: boolean, env: NodeJS.ProcessEnv): Promise<LocalReceipt["checks"]> {
  if (!state.ready || state.profile !== "mixed") throw new Error("Needs a ready mixed profile");
  await assertLocalCluster(state, env);
  await assertLocalDocker(env);
  if (recovery && state.variant !== "lambda") throw new Error("Recovery needs the LocalStack Lambda variant");
  const checks: LocalReceipt["checks"] = [];
  const passed = (id: string) => { checks.push({ id, status: "passed" }); };
  const k = [...kubeArgs(state), "-n", NAMESPACE];
  const portForward = spawn(k[0]!, [...k.slice(1), "port-forward", "--address=127.0.0.1", "service/web", "18080:8080"], { env, stdio: "ignore" });
  const closed = new Promise<void>(resolve => { portForward.once("close", () => resolve()); portForward.once("error", () => resolve()); });
  let forwardExited = false; void closed.then(() => { forwardExited = true; });
  try {
    await waitFor(async () => {
      if (forwardExited) throw new Error("Port-forward exited");
      return (await fetch("http://127.0.0.1:18080/health", { redirect: "error", signal: AbortSignal.timeout(2000) })).ok;
    }, 30_000);
    const tlsProbe = `const https=require("node:https"),fs=require("node:fs");const r=https.get("https://enricher.zenith-j15.svc.cluster.local:8443/health",{ca:fs.readFileSync("/pki/ca.crt"),timeout:5000,minVersion:"TLSv1.3",maxVersion:"TLSv1.3"},s=>{s.resume();process.exitCode=1});r.on("error",e=>{if(!/certificate required|handshake failure/i.test(e.message))process.exitCode=1});r.on("timeout",()=>{r.destroy();process.exitCode=1});`;
    await command([...k, "exec", "deployment/web", "--", "node", "-e", tlsProbe], env);
    passed("tls-peer-auth");
    const db = JSON.parse(await command([...k, "get", "service", "db", "-o", "json"], env)) as { spec: { type: string; ports: { nodePort?: number }[]; externalIPs?: string[] } };
    if (db.spec.type !== "ClusterIP" || db.spec.ports.some(p => p.nodePort) || db.spec.externalIPs?.length) throw new Error("Database is publicly exposed");
    const denyDb = `const postgres=require("postgres");const sql=postgres("postgres://web@db.zenith-j15.svc.cluster.local:5432/mixed",{ssl:"require",connect_timeout:5,max:1});sql\`select 1\`.then(()=>{process.exitCode=1},e=>{if(!/certificate|authentication/.test(e.message))process.exitCode=1}).finally(()=>sql.end({timeout:1}));`;
    await command([...k, "exec", "deployment/web", "--", "node", "-e", denyDb], env);
    passed("private-database");
    async function traffic(runId: string): Promise<TrafficLedger> {
      return runTraffic("http://127.0.0.1:18080", { runId, seed: 15, count: 4, concurrency: 1, replay: 2, timeoutMs: 30_000 });
    }
    async function readback(ledger: TrafficLedger): Promise<void> {
      const query = `begin read only; select coalesce(json_agg(json_build_object('clientKey',client_key,'sku',sku,'qty',qty,'priceCents',price_cents,'checksum',checksum,'webProvider',web_provider,'enricherProvider',enricher_provider)), '[]'::json) from orders where client_key like '${ledger.runId}-%'; rollback;`;
      const data = await command([...k, "exec", "deployment/db", "--", "psql", "-U", "readback", "-d", "mixed", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", query], env);
      const verdict = verifyReadback(ledger, JSON.parse(data.trim()) as StoredOrder[], { channel: "direct_database", kind: "postgres", host: "db.zenith-j15.svc.cluster.local" }, {
        runId: ledger.runId, databaseHostSuffix: ".zenith-j15.svc.cluster.local", expectedProviders: { web: "kind-web", enricher: state.variant === "lambda" ? "localstack-aws-lambda" : "kind-container" },
      });
      if (!verdict.ok) throw new Error("Independent PostgreSQL readback failed");
    }
    const before = await traffic(`${state.runId}-before`);
    if (before.counts.acknowledged !== 6 || before.counts.uncertain || before.counts.rejected) throw new Error("Traffic not fully acknowledged");
    passed("traffic-acknowledged"); await readback(before); passed("independent-readback");
    if (recovery) {
      await command([...composeArgs("mixed"), "stop", "localstack"], env);
      try {
        const during = await runTraffic("http://127.0.0.1:18080", { runId: `${state.runId}-during`, seed: 15, count: 2, concurrency: 1, timeoutMs: 20_000 });
        if (during.counts.acknowledged !== 0 || during.counts.uncertain !== 2) throw new Error("LocalStack outage was not observed");
        passed("partition-unavailable");
        // Before-phase rows must survive; outage writes must be absent, not uncertain in evidence.
        await readback(before);
        const absent = await command([...k, "exec", "deployment/db", "--", "psql", "-U", "readback", "-d", "mixed", "-tAq", "-c", `select count(*) from orders where client_key like '${state.runId}-during-%'`], env);
        if (absent.trim() !== "0") throw new Error("An unacknowledged outage write reached the database");
        passed("outage-readback");
      } finally {
        await command([...composeArgs("mixed"), "start", "localstack"], env);
        await waitFor(async () => (await fetch("http://127.0.0.1:14566/_localstack/health", { redirect: "error", signal: AbortSignal.timeout(3000) })).ok);
        // Stateless AWS partition is reprovisioned from the exact same saved fixture if the emulator lost state.
        await setupLambda(state.root);
      }
      const after = await traffic(`${state.runId}-after`);
      if (after.counts.acknowledged !== 6 || after.counts.uncertain || after.counts.rejected) throw new Error("Traffic did not recover");
      await readback(after); await readback(before); passed("partition-recovered");
    }
    return checks;
  } finally {
    if (!forwardExited) portForward.kill("SIGTERM");
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    if (!forwardExited) portForward.kill("SIGKILL");
  }
}

