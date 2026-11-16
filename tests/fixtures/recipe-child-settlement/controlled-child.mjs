/**
 * Owned child-process fixture for recipe-worker settlement regressions.
 * It acknowledges TERM, then remains alive until its parent sends RELEASE over
 * stdin. That gives the test an explicit live-child checkpoint without sleeps.
 */
process.stdin.setEncoding("utf8");
process.on("SIGTERM", () => process.stdout.write("TERM_ACK\n"));
process.stdin.on("data", (chunk) => {
  if (chunk.split(/\r?\n/).includes("RELEASE")) process.exitCode = 0;
});
process.stdin.on("end", () => process.exit(0));
process.stdout.write("READY\n");
