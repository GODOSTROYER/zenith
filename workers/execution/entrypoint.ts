/** Catch module-load/configuration failures before any driver error reaches logs. */
export async function startExecutionWorker(
  load: () => Promise<unknown> = () => import("./worker"),
  output: { write(text: string): unknown } = process.stdout
): Promise<number> {
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
