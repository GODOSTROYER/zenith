/**
 * Shared hard limits of the machine plane. One place, so the argument
 * schemas, the service, every transport and the SSM documents agree.
 *
 * These are ceilings, not defaults a caller can raise: `timeoutSec` and
 * `maxOutputBytes` on a request are validated against them, and a policy
 * "restrict" constraint on the capability grant can only lower them further.
 */

/** wall-clock ceiling for any single machine request */
export const MAX_TIMEOUT_SEC = 300;
export const DEFAULT_TIMEOUT_SEC = 30;

/** output ceiling for any single machine request (1 MiB) */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** `machine.exec` / `container.exec` argv shape */
export const MAX_ARGV_ITEMS = 32;
export const MAX_ARGV_ITEM_CHARS = 4096;
/** sum of all argv element lengths; keeps one SSM command line well under document limits */
export const MAX_ARGV_TOTAL_CHARS = 32 * 1024;

export const MAX_PATH_CHARS = 1024;
export const MAX_LOG_LINES = 5000;
export const DEFAULT_LOG_LINES = 200;
/** relative `since` ceiling: 7 days */
export const MAX_SINCE_SEC = 7 * 24 * 60 * 60;
export const MAX_PROCESS_LIMIT = 500;
export const MAX_CONTAINER_LIMIT = 200;
export const MAX_PORT_CHECK_TIMEOUT_SEC = 30;
export const DEFAULT_FILE_READ_BYTES = 64 * 1024;

/**
 * AWS `GetCommandInvocation` returns at most the first 24,000 characters of
 * stdout and the first 8,000 characters of stderr (AWS API reference). Anything
 * larger is truncated by AWS before Zenith sees it; the SSM transport reports
 * that honestly as `truncated` and never claims to have read more.
 */
export const SSM_STDOUT_LIMIT_CHARS = 24_000;
export const SSM_STDERR_LIMIT_CHARS = 8_000;
/**
 * `file.read` over SSM: content travels base64-encoded inside stdout, so the
 * usable raw size is ~3/4 of what is left of the 24,000-character budget after
 * the header lines. 16 KiB keeps a wide margin. Larger reads need zenithd.
 */
export const SSM_FILE_READ_MAX_BYTES = 16 * 1024;
/** SSM `SendCommand.Comment` is limited to 100 characters */
export const SSM_COMMENT_MAX_CHARS = 100;

/**
 * Default `file.read` allowlist for transports Zenith enforces it on (aws_ssm
 * document + kubernetes). A prefix ending in `/` allows a directory subtree; a
 * prefix without a trailing `/` allows exactly that file. Environments narrow
 * or replace this list; zenithd applies its own local `files.readAllow`.
 */
export const DEFAULT_FILE_READ_PREFIXES: readonly string[] = [
  "/var/log/",
  "/etc/nginx/",
  "/etc/systemd/system/",
  "/opt/",
  "/srv/",
];

/**
 * Path fragments that are refused for `file.read` even inside an allowed
 * prefix (private keys, credential stores, process memory/environment). The
 * SSM FileRead document and the Kubernetes transport apply the same list.
 * Best-effort: a secret in a differently named file is not caught, which is why
 * `file.read` is a medium-risk capability and its output is redacted.
 */
export const FILE_READ_DENY_GLOBS: readonly string[] = [
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*id_rsa*",
  "*id_ed25519*",
  "*.env",
  "*/.env*",
  "*/.ssh/*",
  "*/.aws/*",
  "*/.kube/*",
  "*/.docker/*",
  "*/shadow*",
  "*/gshadow*",
  "*/sudoers*",
  "*credentials*",
  "*secret*",
  "/proc/*",
  "/sys/*",
  "/dev/*",
];
