import { it, expect } from "vitest";
import { main } from "./cli";
import type { Provider } from "./contracts";

// Not selected by the builder's offline command. Mac only, after accountable live approval.
for (const provider of ["azure", "gcp", "oci"] as Provider[]) {
  const P = provider.toUpperCase();
  const enabled = process.env[`ZENITH_LIVE_${P}`] === "1";
  if (!enabled) console.warn(`NOT RUN (not a pass): ${provider} needs ZENITH_LIVE_${P}=1 and approved permissions.json`);
  it.skipIf(!enabled)(`live ${provider}: operated fixture checks, human teardown and empty inventory`, async () => {
    for (const name of [`ZENITH_LIVE_${P}_PACKET_FILE`, "ZENITH_LIVE_PERMISSIONS_FILE", `ZENITH_LIVE_${P}_EVIDENCE_FILE`]) expect(process.env[name], `Required FILE reference: ${name}`).toBeTruthy();
    const code = await main(provider, ["--packet", process.env[`ZENITH_LIVE_${P}_PACKET_FILE`]!, "--permissions", process.env.ZENITH_LIVE_PERMISSIONS_FILE!, "--out", process.env[`ZENITH_LIVE_${P}_EVIDENCE_FILE`]!]);
    expect(code).toBe(0);
  }, 2 * 60 * 60_000);
}
const dns = process.env.ZENITH_LIVE_DNS === "1";
if (!dns) console.warn("NOT RUN (not a pass): DNS/ACME needs ZENITH_LIVE_DNS=1 and provider opt-in");
it.skipIf(!dns)("live DNS/ACME: ownership refusals, domain proof/renewal and trusted certificate", async () => {
  const provider = process.env.ZENITH_LIVE_DNS_PROVIDER as Provider;
  expect(["azure", "gcp", "oci"]).toContain(provider);
  const code = await main(provider, ["--packet", process.env.ZENITH_LIVE_DNS_PACKET_FILE!, "--permissions", process.env.ZENITH_LIVE_PERMISSIONS_FILE!, "--out", process.env.ZENITH_LIVE_DNS_EVIDENCE_FILE!], process.env, true);
  expect(code).toBe(0);
}, 2 * 60 * 60_000);
