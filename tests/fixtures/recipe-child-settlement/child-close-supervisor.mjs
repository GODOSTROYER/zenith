/** Test-only IPC supervisor for exact child-process close acknowledgements. */
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";

const MAX_CHILDREN = 32;
const records = new Map();
let observed = 0;
let serviceObserved = false;
let uncertain = false;
let cleanupRequested = false;
let acknowledged = false;

function maybeAcknowledge() {
  if (!cleanupRequested || acknowledged || uncertain || !serviceObserved) return;
  if ([...records.values()].some((record) => !record.closed)) return;
  acknowledged = true;
  if (typeof process.send !== "function" || !process.connected) {
    uncertain = true;
    return;
  }
  try {
    process.send({ type: "OWNED_CHILDREN_CLOSED_SNAPSHOT", observed, closed: records.size }, (error) => {
      if (error) {
        uncertain = true;
      }
    });
  } catch {
    uncertain = true;
  }
}

channel("child_process").subscribe((message) => {
  try {
    if (!message || !(message.process instanceof ChildProcess)) {
      uncertain = true;
      return;
    }
    const child = message.process;
    // A later constructor invalidates the prior informational close snapshot.
    acknowledged = false;
    observed += 1;
    if (observed > MAX_CHILDREN) {
      uncertain = true;
      return;
    }

    const record = { child, closed: false };
    records.set(child, record);
    child.once("spawn", () => {
      const args = Array.isArray(child.spawnargs) ? child.spawnargs : [];
      if (args.some((arg) => typeof arg === "string" && arg.startsWith("--service=")) && args.includes("--ping")) {
        serviceObserved = true;
      }
      maybeAcknowledge();
    });
    child.once("close", () => {
      record.closed = true;
      maybeAcknowledge();
    });
    child.once("error", () => {
      // A constructor with no later close event is not treated as settled.
    });
  } catch {
    uncertain = true;
  }
});

process.on("message", (message) => {
  if (message && message.type === "CLEANUP_OWNED_CHILDREN") {
    cleanupRequested = true;
    maybeAcknowledge();
  }
});

// Keep the observer subscribed for the supervised process lifetime. The
// unref'd IPC channel accepts cleanup commands without blocking beforeExit.
if (process.channel && typeof process.channel.unref === "function") process.channel.unref();
