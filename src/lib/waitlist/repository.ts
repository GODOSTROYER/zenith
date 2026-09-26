import path from "node:path";
import { env } from "@/lib/env";
import { isServerless } from "@/lib/serverless";
import type { WaitlistRepository } from "./types";

type WaitlistGlobal = typeof globalThis & {
  __zenithWaitlistFiles?: Map<string, WaitlistRepository>;
};

/** Independent authority with the same file/Postgres selector as the product. */
export async function waitlistRepository(): Promise<WaitlistRepository> {
  const config = env();
  if (config.ZENITH_STORE === "postgres") {
    const { postgresWaitlistRepository } = await import("./postgres");
    return postgresWaitlistRepository();
  }
  if (isServerless()) throw new Error("Waitlist storage requires ZENITH_STORE=postgres on serverless hosts.");
  const file = path.resolve(config.ZENITH_DATA, "waitlist.sqlite");
  const global = globalThis as WaitlistGlobal;
  const repositories = (global.__zenithWaitlistFiles ??= new Map());
  let repository = repositories.get(file);
  if (!repository) {
    const { FileWaitlistRepository } = await import("./file");
    // The import yields: check again so simultaneous requests share one handle.
    repository = repositories.get(file);
    if (!repository) {
      repository = new FileWaitlistRepository(file);
      repositories.set(file, repository);
    }
  }
  return repository;
}