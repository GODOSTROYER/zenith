/**
 * AWS naming and tagging conventions shared by the broker's session policies,
 * the customer bootstrap templates (`deploy/aws`) and — by agreement — the
 * OpenTofu compiler and AWS drivers.
 *
 *   - every resource Zenith creates is named `zenith-<environmentId>-…` (or
 *     lives under a `/zenith/<environmentId>/` path for log groups)
 *   - every resource Zenith creates is tagged `zenith:managed=true` and
 *     `zenith:environment=<environmentId>`
 *
 * The deploy role and the per-capability session policies both key off these,
 * so a resource that breaks the convention is simply outside Zenith's reach —
 * which is the safe failure.
 *
 * Caveat (documented, not fixable in IAM): name patterns end in a `-` or `/`
 * delimiter, so environment ids that are hyphen-delimited prefixes of one
 * another (`prod` and `prod-eu`) overlap in name-based patterns. Fixed-width
 * ids (UUIDs) cannot overlap. The tag condition (`zenith:environment`, exact
 * match) is the precise boundary where the service supports it.
 */

export const TAG_MANAGED = "zenith:managed";
export const TAG_ENVIRONMENT = "zenith:environment";
export const TAG_WORKSPACE = "zenith:workspace";
export const TAG_OPERATION = "zenith:operation";
export const TAG_CAPABILITY = "zenith:capability";

export const NAME_PREFIX = "zenith-";

/**
 * Reserved for CodeBuild service roles, never application identities. The
 * driver appends this suffix AFTER cloudName truncates/hashes the base. The
 * bootstrap policy generator verifies its PrincipalArn against this pattern.
 */
export const BUILD_ROLE_SUFFIX = "-build";
export const BUILD_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${BUILD_ROLE_SUFFIX}`;

/** EventBridge invocation and EC2 agent roles reserve these after truncation too. */
export const EVENTS_ROLE_SUFFIX = "-events";
export const EVENTS_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${EVENTS_ROLE_SUFFIX}`;
export const EC2_ROLE_SUFFIX = "-ec2";
export const EC2_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${EC2_ROLE_SUFFIX}`;

/** Environment ids embedded in ARN patterns: no wildcards, no policy variables, no separators. */
export const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const environmentName = (environmentId: string): string => `${NAME_PREFIX}${environmentId}`;
