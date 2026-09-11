/**
 * Source intake — the untrusted-input boundary of the hosted product.
 *
 * Everything a builder submits enters here and leaves as a `ValidatedSource`
 * with a pinned digest, or as one `unsupported_source` error listing every
 * reason at once. No submitted file is ever executed, parsed as configuration,
 * or installed from.
 *
 *   tar.ts          bounded ustar/GNU reader over a (gzipped) buffer
 *   validate.ts     the supported-source contract, for tarballs and directories
 *   materialize.ts  write a validated source into a scratch directory
 */
export { SOURCE_FIX, readTar, safeEntryPath, scanTar, type SafePath, type TarScan } from "./tar";
export { scanDirectory, sourceDigest, validateSource, type SourceInput } from "./validate";
export { MATERIALIZE_PREFIX, materializeSource, removeMaterialized } from "./materialize";
