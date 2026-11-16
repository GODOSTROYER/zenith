/** Catch module-load/configuration failures before any driver error reaches logs. */
export async function startExecutionWorker(
  load: () => Promise<unknown> = () => import("./worker"),
  output: { write(text: string): unknown } = process.stdout,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  // Match the plan fingerprint key contract before imports can validate the
  // environment. Importing that validator here would load worker dependencies.
  if (!env.ZENITH_SECRET_KEY || !/^[a-f0-9]{64}$/i.test(env.ZENITH_SECRET_KEY)) {
    output.write(`${JSON.stringify({ level: "error", msg: "execution worker failed", component: "execution-worker",
      failureCategory: "configuration", error: "Execution requires ZENITH_SECRET_KEY (64 hex characters); plan fingerprints cannot use the public default." })}\n`);
    return 1;
  }
  try { await load(); return 0; }
  catch {
    output.write(`${JSON.stringify({ level: "error", msg: "execution worker failed", component: "execution-worker",
      failureCategory: "module-load", error: "Worker modules could not load; check packaged dependencies and configuration." })}\n`);
    return 1;
  }
}

if (process.argv[1] && /(?:entrypoint\.ts|worker\.cjs)$/.test(process.argv[1])) {
  void startExecutionWorker().then((code) => { if (code !== 0) process.exitCode = code; });
}
