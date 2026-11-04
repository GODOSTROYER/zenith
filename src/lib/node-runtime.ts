/** Supported runtime for the locked toolchain; keep package.json engines aligned. */
export const SUPPORTED_NODE_RANGE = ">=22.22.2 <23";
export const MIN_NODE = { major: 22, minor: 22, patch: 2 } as const;

/** Complete stable versions only: unknown versions must never pass admission. */
export function nodeIsSupported(version: string): boolean {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major === MIN_NODE.major &&
    (minor > MIN_NODE.minor || (minor === MIN_NODE.minor && patch >= MIN_NODE.patch));
}
