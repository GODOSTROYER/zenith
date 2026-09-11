/**
 * The worker source the Cloudflare runtime uploads for a release, and the
 * compatibility date every script it uploads is pinned to.
 *
 * It lives in its own file because it is *not* TypeScript this project
 * compiles: it is a string that becomes a module on somebody else's runtime.
 * Keeping it beside the adapter's logic invited it to grow — and the whole
 * isolation argument rests on this module doing exactly one thing, with
 * exactly one capability (`ASSETS`) and no way to reach data.
 *
 * The broker worker is the opposite case and is deliberately not here: it is
 * platform code, bundled from `workers/broker-worker.ts` and read from the
 * path `ZENITH_CF_BROKER_MODULE` names, never generated.
 *
 * Workstream W6 (hosted R3).
 */

/** Compatibility date every uploaded script is pinned to. Pinned, never "today". */
export const CF_COMPATIBILITY_DATE = "2026-09-01";

/** The release worker: assets only, no logic, no capability but its own files. */
export const RELEASE_WORKER_MODULE = `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`;
