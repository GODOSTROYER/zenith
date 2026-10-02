/** Restrict the packaged fixture client to the harness's disposable resources. */
export const PACKAGED_PLAN_DIR = "/var/lib/zenith/platform-plans";

export function assertPackagedAcceptanceTarget(env: Readonly<Record<string, string | undefined>>): void {
  let valid = false;
  try {
    const target = new URL(env.ZENITH_PLATFORM_DB_URL ?? "");
    valid = ["postgres:", "postgresql:"].includes(target.protocol) && target.hostname === "postgres"
      && target.port === "5432" && target.pathname === "/zenith_packaged" && target.search === "";
  } catch { /* fixed refusal below */ }
  if (!valid || env.ZENITH_PACKAGED_ACCEPTANCE !== "1" || env.ZENITH_STORE !== "file"
      || env.ZENITH_DATA !== "/var/lib/zenith" || env.ZENITH_WORKER_PLAN_DIR !== PACKAGED_PLAN_DIR
      || env.ZENITH_TEMPORAL_ADDRESS !== "temporal:7233") {
    throw new Error("Packaged acceptance only targets its isolated disposable store and Temporal network.");
  }
}
