/**
 * Write one PLATFORM credential into the encrypted vault's platform scope (PROD-MAN-01).
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/managed/seed-platform-vault.ts \
 *     --ref vault:zenith-managed/kubeconfig --file <path|->
 *
 * The managed substrate resolves `ZENITH_MANAGED_KUBECONFIG_REF`, `ZENITH_MANAGED_DB_API_KEY_REF`
 * and the object-storage credential from the platform scope (`ZENITH_MANAGED_VAULT_SCOPE`, default
 * `zenith-platform`): a reserved workspace id no customer workspace has, so no tenant surface can
 * read it. This is the only way values get there. Nothing in the product writes the scope.
 *
 * The value comes from a FILE (or stdin with `--file -`), never from an argument, so it does not
 * land in shell history or a process listing. Output is the reference and the new version only.
 * The store is the one `ZENITH_STORE` selects, sealed under `ZENITH_SECRET_KEY` exactly like every
 * other secret (AES-256-GCM with the scope and reference authenticated alongside the value).
 *
 * Exit 0 written, 1 failure, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { platformVaultScope } from "@/lib/platform/zenith-managed";
import { putSecretAsync } from "@/lib/secrets";
import { isVaultRef } from "@/lib/secrets/refs";

const USAGE = "Usage: npx tsx --env-file-if-exists=.env.local scripts/managed/seed-platform-vault.ts --ref <vault:reference> --file <path|->";

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env, out: (line: string) => void = console.log): Promise<number> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--ref" && flag !== "--file") || value === undefined || values.has(flag)) { out(USAGE); return 2; }
    values.set(flag, value);
  }
  const ref = values.get("--ref");
  const file = values.get("--file");
  if (!ref || !file || !isVaultRef(ref) || /\s/.test(ref)) { out(USAGE); return 2; }
  try {
    const scope = platformVaultScope(env);
    const value = readFileSync(file === "-" ? 0 : file, "utf8").trim();
    const meta = await putSecretAsync(scope, ref, value, "operator:seed-platform-vault");
    out(`wrote ${ref} to the platform vault scope (version ${meta.version})`);
    return 0;
  } catch (error) {
    // Never print the cause: it can carry a path or a fragment of the value's context.
    out(`failed: ${error instanceof Error && /ZENITH_SECRET_KEY|ZENITH_MANAGED_VAULT_SCOPE|too large|needs a value/i.test(error.message) ? error.message.slice(0, 200) : "the value could not be written"}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
