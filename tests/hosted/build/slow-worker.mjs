/**
 * A worker double that never finishes, so the timeout and the abort signal are
 * exercised against a real child process rather than a mock.
 *
 * It prints one line first, so the test can also see that log capture works
 * before the kill, and it keeps a timer alive so the process only ends when it
 * is killed.
 *
 * Test support only. Workstream W2 (hosted R3).
 */
process.stdout.write("slow worker: started, will not finish\n");
setInterval(() => {
  /* hold the event loop open until SIGKILL */
}, 1000);
