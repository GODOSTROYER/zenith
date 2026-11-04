/**
 * Live billing gate. A billing read touches a real cloud account, so it is off
 * unless the operator opts in per provider with TWO variables:
 *
 *   ZENITH_LIVE_<PROVIDER>=1                           explicit opt-in
 *   ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE    absolute path to a JSON credentials file
 *
 * Credentials are never read from environment variable VALUES, never accepted
 * in a request, and never logged: only the file path is configuration.
 * `<PROVIDER>` is AWS, GCP, AZURE or OCI.
 */
import { isAbsolute } from "node:path";
import type { BillingProvider } from "@/lib/cost/kinds";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type BillingGate = { open: true; credentialsFile: string } | { open: false; reason: string };

export function billingGateVariables(provider: BillingProvider): { optIn: string; credentialsFile: string } {
  const p = provider.toUpperCase();
  return { optIn: `ZENITH_LIVE_${p}`, credentialsFile: `ZENITH_LIVE_${p}_BILLING_CREDENTIALS_FILE` };
}

export function billingGate(provider: BillingProvider, env: EnvLike): BillingGate {
  const vars = billingGateVariables(provider);
  if (env[vars.optIn] !== "1") return { open: false, reason: `${vars.optIn}=1 is not set; live ${provider.toUpperCase()} billing reads are disabled.` };
  const file = env[vars.credentialsFile];
  if (!file) return { open: false, reason: `${vars.credentialsFile} is not set; a credentials file path is required.` };
  if (!isAbsolute(file)) return { open: false, reason: `${vars.credentialsFile} must be an absolute path.` };
  return { open: true, credentialsFile: file };
}
