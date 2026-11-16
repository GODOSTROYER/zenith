export interface PublishedReleaseSource {
  schema: "zenith.published-release-source.v1"; commit: string; mode: "live"; requirements: ["PROD-OPS-09"];
  counts: { passed: number; failed: number; skipped: number }; exitCode: number; verdict: "passed";
  command: string; environment: string; evidence: { manifestSha256: string; artifacts: number }; result: string;
}
export function publishedReleaseSource(input: {
  bundle: string; tag: string; repository: string; runUrl: string; keys: { kid: string; publicKey: string }[]; lock: string; now?: Date;
}): { errors: string[]; source?: PublishedReleaseSource };
