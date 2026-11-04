import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stopOwnedWorker } from "../../scripts/acceptance/maintenance/default";

type OwnedChild = {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasClosed: () => boolean;
};

function start(script: string): OwnedChild {
  const child = spawn(process.execPath, ["-e", script], {
    env: { NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let didClose = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => {
      didClose = true;
      resolve({ code, signal });
    });
  });
  return { child, closed, hasClosed: () => didClose };
}

async function closeWithin(owner: OwnedChild, timeoutMs: number): Promise<boolean> {
  if (owner.hasClosed()) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void owner.closed.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function waitForReady(owner: OwnedChild, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const onMessage = (message: unknown) => { if (message === "ready") finish(true); };
    const onClose = () => finish(false);
    const onError = () => finish(false);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      owner.child.removeListener("message", onMessage);
      owner.child.removeListener("close", onClose);
      owner.child.removeListener("error", onError);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    owner.child.on("message", onMessage);
    owner.child.once("close", onClose);
    owner.child.once("error", onError);
  });
}

async function cleanup(owner: OwnedChild): Promise<void> {
  if (!owner.hasClosed()) owner.child.kill("SIGKILL");
  expect(await closeWithin(owner, 5_000)).toBe(true);
}

describe("J4 owned worker process lifecycle", () => {
  it("accepts a direct child closed by SIGTERM", async () => {
    const owner = start("process.on('SIGTERM', () => process.exit(0)); process.send?.('ready'); setInterval(() => {}, 1000)");
    try {
      expect(await waitForReady(owner, 5_000)).toBe(true);
      await stopOwnedWorker(owner.child);
      expect(owner.hasClosed()).toBe(true);
      expect(owner.child.signalCode === "SIGTERM" || owner.child.exitCode === 0).toBe(true);
    } finally {
      await cleanup(owner);
    }
  }, 30_000);

  it("refuses a child that exited before the planned stop", async () => {
    const owner = start("process.exit(0)");
    try {
      expect(await closeWithin(owner, 5_000)).toBe(true);
      await expect(stopOwnedWorker(owner.child)).rejects.toThrow("Owned worker exited before the planned stop.");
    } finally {
      await cleanup(owner);
    }
  }, 30_000);

  it("refuses forced SIGKILL after reaping the owned child", async () => {
    const owner = start("process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000)");
    try {
      expect(await waitForReady(owner, 5_000)).toBe(true);
      await expect(stopOwnedWorker(owner.child)).rejects.toThrow("Owned worker did not stop cleanly after SIGTERM.");
      expect(owner.hasClosed()).toBe(true);
      expect(owner.child.signalCode).toBe("SIGKILL");
    } finally {
      await cleanup(owner);
    }
  }, 30_000);
});
