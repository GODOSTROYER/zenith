/** Generate the non-secret OCI contract embedded by the Go runner. No network. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OCI_ALLOWLIST } from "../src/lib/providers/oci/allowlist";
import { OCI_SERVICE_HOSTS } from "../src/lib/providers/oci/services";

const dir = new URL("../go/internal/oci/testdata/", import.meta.url);
mkdirSync(fileURLToPath(dir), { recursive: true });
for (const [name, value] of Object.entries({ allowlist: OCI_ALLOWLIST, services: OCI_SERVICE_HOSTS })) {
  writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(value, null, 2)}\n`);
}
