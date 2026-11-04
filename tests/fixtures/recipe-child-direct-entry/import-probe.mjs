import path from "node:path";
import { pathToFileURL } from "node:url";
import { channel } from "node:diagnostics_channel";

const workerPath = path.resolve(process.argv[2]);
const childProcess = channel("child_process");
const before = childProcess.hasSubscribers;
await import(pathToFileURL(workerPath).href);
const after = childProcess.hasSubscribers;
process.stdout.write(`${JSON.stringify({ event: "IMPORT_COMPLETE", before, after })}\n`);
