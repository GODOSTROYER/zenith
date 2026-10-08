#!/usr/bin/env -S npx --no-install tsx
import { runPluginCli } from "./main";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
void runPluginCli(process.argv.slice(2), { signal: controller.signal }).then((code) => {
  process.exitCode = code;
}).finally(() => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  process.stdin.pause();
});
