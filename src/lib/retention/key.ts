import { KeyRing } from "@/lib/keycustody/registry";

/** Separate archive purpose, derived from the operator backup root. No raw backup-key fallback. */
export function archiveKey(env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  return KeyRing.fromEnv(env, { purposes: ["enc:archive"] }).useKey("enc:archive", "encrypt");
}
