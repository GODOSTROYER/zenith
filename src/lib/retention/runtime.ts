/**
 * The production wiring of restore dependencies: the operator archive target from configuration (the fallback
 * destination) and the brokered tenant destination path. Tests inject their own `ResolveDeps`.
 */
import { archiveTargetFromEnv } from "./archive";
import type { ResolveDeps } from "./destination";

export function restoreDepsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ResolveDeps {
  const choice = archiveTargetFromEnv(env);
  return { operator: choice.ok ? choice.target : undefined };
}
