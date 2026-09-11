/**
 * Is this process a serverless instance rather than a server?
 *
 * Zenith's background machinery — the pid lock on the data directory, the
 * engine's 250ms ticker, the alert evaluator's 15s pass — all assume one
 * long-lived process that owns its data directory. On Vercel none of that
 * holds: an instance is created for a request and frozen after it, each one
 * has its own `/tmp`, and a timer that fires between requests either does not
 * run at all or runs against storage no other instance will ever see. Starting
 * them there buys nothing and the pid lock actively refuses boot, because the
 * "other process" whose lock it finds is a previous instance of this one.
 *
 * Two inputs, and both are explicit: `VERCEL` is set by the platform on every
 * build and runtime instance, and `ZENITH_SERVERLESS=1` says the same thing
 * for anywhere else that runs this way (and for the tests that assert it).
 * Local `next dev` sets neither, so nothing about it changes.
 */
export const isServerless = (): boolean =>
  process.env.ZENITH_SERVERLESS === "1" || !!process.env.VERCEL;
