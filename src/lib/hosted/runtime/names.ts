/**
 * Provider-side resource names.
 *
 * These live in their own leaf module because two directories need them and
 * neither may import the other: the gateway's admission decision tells an edge
 * worker *which script to dispatch*, and the Cloudflare adapter is what
 * uploaded that script. If the two ever disagreed, a request would be admitted
 * for one release and served by another.
 *
 * Both names are content-addressed on purpose. A release script carries the
 * artifact digest, so two different builds can never contend for one name and
 * a name can never be quietly reused for different bytes.
 *
 * Workstream W6 (hosted R3).
 */

/** `zenith-<slug>-r<number>-<first 12 of digest>` — one script per set of bytes. */
export const releaseScriptName = (slug: string, releaseNumber: number, digest: string): string =>
  `zenith-${slug}-r${releaseNumber}-${digest.slice(0, 12)}`;

/** `zenith-<slug>-broker` — the fixed, trusted data worker; one per app, never per release. */
export const brokerScriptName = (slug: string): string => `zenith-${slug}-broker`;
