import { KeyRing } from "@/lib/keycustody/registry";

/** Separate archive purpose, derived from the operator backup root. No raw backup-key fallback. */
export function archiveKey(): Buffer {
  return KeyRing.fromEnv(process.env, { purposes: ["enc:archive"] }).useKey("enc:archive", "encrypt");
}
