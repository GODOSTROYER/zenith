/**
 * Startup checks for key custody (PROD-OPS-05). Only separation findings are checked here (key material shared
 * between purposes, the same signer used twice, a release private key present on the control plane). Whether each
 * purpose is configured and valid is checked by its own consumer, which already refuses to start without it.
 * Findings are fixed codes and purposes: no key ids, no material, no configuration values.
 */
import { KeyCustodyError } from "./purposes";
import { KeyRing, type EnvSource, type KeyViolation } from "./registry";

/** Error-level separation findings, excluding per-purpose configuration errors. */
export function custodySeparationErrors(env: EnvSource = process.env): KeyViolation[] {
  return KeyRing.fromEnv(env).violations().filter((v) => v.severity === "error" && v.code !== "key_config_invalid");
}

/** Throws a fixed-message `key_purpose_violation` when keys are not separated. */
export function assertCustodyAtStartup(env: EnvSource = process.env): void {
  const bad = custodySeparationErrors(env);
  if (bad.length) throw new KeyCustodyError("key_purpose_violation", `Key custody refused startup: ${bad.map((v) => v.code).join(", ")}. Run scripts/key-custody.ts diagnose.`);
}
