#!/usr/bin/env -S npx --no-install tsx
/** Executable entry: SIGINT/SIGTERM abort HTTP, stdin and follow polling.
 * Exit status is returned by main so resources can close without process.exit. */
import { runCli } from "./main";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
void runCli(process.argv.slice(2), { signal: controller.signal }).then((code) => {
  process.exitCode = code;
}).finally(() => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  process.stdin.pause();
});
