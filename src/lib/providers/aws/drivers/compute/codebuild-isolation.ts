/**
 * Egress and metadata guard for CodeBuild source builds (PROD-LIFE-09).
 *
 * CodeBuild runs the build in a privileged container with its own Docker
 * daemon. Hostile Dockerfile `RUN` steps execute in child containers whose
 * traffic is FORWARDED by that container's kernel; the buildspec's own
 * commands, the daemon's image pulls and `docker push` leave through OUTPUT
 * and are unaffected. The guard therefore installs a first-position FORWARD
 * chain, before the Dockerfile runs, that
 *
 *   - rejects the EC2 instance metadata address (169.254.169.254) and the
 *     container credentials endpoint (169.254.170.2);
 *   - allows replies, DNS, and TCP 443 only to the IP addresses the allowlisted
 *     host names resolve to at build start;
 *   - rejects everything else;
 *
 * and then ABORTS the build if the chain is not the first FORWARD rule. The
 * allowlist is IP based and resolved once per build, so a host served from a
 * shared CDN admits its neighbours; DNS itself is open (a covert channel).
 * Those limits are written into the profile's `mechanism` text and the
 * limitations list, not hidden.
 *
 * The buildspec is the evidence: `hostsFromBuildspec` recovers the allowlist
 * from an executed buildspec so the build adapter can prove the executed text
 * is exactly what Zenith generated for that allowlist.
 */

/** Package registries a typical Dockerfile needs; the operator extends this per pipeline. */
export const DEFAULT_BUILD_EGRESS_HOSTS: readonly string[] = [
  "archive.ubuntu.com",
  "auth.docker.io",
  "deb.debian.org",
  "dl-cdn.alpinelinux.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "proxy.golang.org",
  "production.cloudflare.docker.com",
  "pypi.org",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "repo.maven.apache.org",
  "rubygems.org",
  "security.debian.org",
  "security.ubuntu.com",
  "static.crates.io",
  "sum.golang.org",
];

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Defaults plus validated extras, lower-cased, de-duplicated, sorted. Throws on anything that is not a plain DNS name. */
export function egressHosts(extra: readonly string[] | undefined): string[] {
  const all = [...DEFAULT_BUILD_EGRESS_HOSTS];
  for (const raw of extra ?? []) {
    const h = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!HOST.test(h)) throw new Error(`isolation.allowedHosts entry ${JSON.stringify(String(raw).slice(0, 60))} is not a plain DNS name.`);
    all.push(h);
  }
  return [...new Set(all)].sort();
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const MARK = "ZENITH_EGRESS_HOSTS=";

/** buildspec `commands:` entries (already YAML-quoted, two-space indented under pre_build). */
export function egressGuardCommands(hosts: readonly string[]): string[] {
  for (const h of hosts) if (!HOST.test(h)) throw new Error("egress host is not a plain DNS name.");
  const cmds = [
    `${MARK}"${hosts.join(" ")}"`,
    "iptables -N ZENITH_EGRESS",
    "iptables -A ZENITH_EGRESS -d 169.254.169.254 -j REJECT",
    "iptables -A ZENITH_EGRESS -d 169.254.170.2 -j REJECT",
    "iptables -A ZENITH_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "iptables -A ZENITH_EGRESS -p udp --dport 53 -j ACCEPT",
    "iptables -A ZENITH_EGRESS -p tcp --dport 53 -j ACCEPT",
    `for h in $ZENITH_EGRESS_HOSTS; do for ip in $(getent ahostsv4 "$h" | awk '{print $1}' | sort -u); do iptables -A ZENITH_EGRESS -d "$ip" -p tcp --dport 443 -j ACCEPT; done; done`,
    "iptables -A ZENITH_EGRESS -j REJECT",
    "iptables -I FORWARD 1 -j ZENITH_EGRESS",
    `test "$(iptables -S FORWARD | sed -n 2p)" = "-A FORWARD -j ZENITH_EGRESS"`,
  ];
  return cmds.map((c) => `      - ${quote(c)}`);
}

/** The build context directory an executed Docker buildspec builds from ("." when it builds the root). */
export function contextDirFromBuildspec(buildspec: string | undefined): string {
  const m = typeof buildspec === "string" ? /docker build -f "[$]ZENITH_DOCKERFILE" -t "[$]ZENITH_REPO_URL:src-[$]ZENITH_SOURCE_DIGEST" (?:'([A-Za-z0-9._/-]{1,200})'|[.])\s*$/m.exec(buildspec) : null;
  return m?.[1] ?? ".";
}

/** The allowlist an executed buildspec declares, or undefined when it carries no (single, well-formed) guard. */
export function hostsFromBuildspec(buildspec: string | undefined): string[] | undefined {
  if (typeof buildspec !== "string") return undefined;
  const found = [...buildspec.matchAll(new RegExp(`^      - '${MARK}"([a-z0-9. -]{1,4000})"'$`, "gm"))];
  if (found.length !== 1) return undefined;
  const hosts = found[0][1].split(" ");
  return hosts.every((h) => HOST.test(h)) ? hosts : undefined;
}
