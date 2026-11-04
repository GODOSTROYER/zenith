# AWS boundary preflight source handoff, 2026-10-04

This bounded source lane advances PROD-LIFE-03. It does not close that requirement,
independent live IAM acceptance, or the complete 78-requirement program. No cloud
call, IAM write, boundary attach or detach, compiler, test, lint, dependency
installation, service, database, Docker invocation or commit was performed.
Only the explicitly authorized source-generation command was executed. Root
owns independent review and serial runtime acceptance.

The isolated worktree is
`/Users/saivedanthava/.codex/zenith-production/worktrees/aws-bootstrap-preflight-20261004`,
branch `ws/prod-aws-bootstrap-preflight-20261004`, prepared clean at
`a9af54c66099a44aafa92765b934129e30f5fa32`. Before editing, the prepared receipt
recorded all 3,708 tracked file hashes, four initial owned before-images, the real
index hash and the absence of `node_modules`. Root explicitly expanded ownership
to the CloudFormation source, generated observe policy and existing bootstrap
test. Those three matching prepared before-images were saved before editing.
`node_modules` now reuses the existing `g1-candidate-20261003/node_modules` through
a symlink, with no installation or fresh-install claim. Exact freeze material is in
`/Users/saivedanthava/.codex/zenith-production/logs/aws-bootstrap-preflight-20261004/revision1`.
The receipt, source copies and patch are authoritative for this packet.

## Read-only contract

`preflightAwsBootstrap` accepts the existing `AwsSession`, saved
`AwsConnectionConfig` and a bounded native role inventory with workspace and
environment identifiers. The trusted owning callback must derive that inventory
from the current approved native plan/provider identities; the helper does not
create authority. It derives exact policy ARNs through
`awsBootstrapContextForConnection` and `resolveAwsRoleBoundaries`, and derives a
role's family from the existing reserved suffix map. It accepts no arbitrary
policy ARN, credentials, client constructor, transport callback or authorization
proof. The modeled tests use the existing guarded runner session and native IAM
SDK commands, with explicit reply models and no credential values.

The helper requests `GetPolicy`, `GetPolicyVersion` and `GetRole` only. For each
of six families it checks the returned ARN, name, root path, stable policy ID,
attachability and default version; requests that exact version; validates the
version identity/default marker; then reads policy metadata again to detect a
changed default or recreated policy. Every Allow must carry the exact canonical
family PrincipalArn patterns, and the unconditional family-exclusion Deny must
match them. Other permission statements are not compared with the entire
bootstrap document, and no IAM policy evaluation is performed. All deploy/family
policy grants remain unchanged. The sole bootstrap grant addition is the exact
two-action/seven-resource observe read statement described below. Tests pair each
committed CloudFormation family rendering with its generated OpenTofu source.

IAM role readback must match the exact requested ARN/name/root path, a native
role ID, the `zenith:managed=true` tag and the native workspace/environment tags.
The attached boundary must be that role's exact family ARN or the exact retained
legacy ARN for the saved suffix. Foreign or missing roles, wrong families,
unbounded or duplicate inventories, paths outside the canonical patterns and
absent boundaries refuse. The input inventory is copied before the first await.
A matching legacy role reports `migration_required`; it never authorizes a
detach. Legacy policy metadata is read separately, and an absent legacy policy
still reported on a role conflicts.

Inputs are validated before constructing a native IAM client through the scoped
session. The helper refuses emulator, static-dev and endpoint-override inputs.
The current runtime connection validation remains commercial AWS only. No
China/GovCloud runtime support is introduced.

The limits are 32 roles, 51 SDK sends, one shared 30-second abort signal, 131,072
incoming document characters, 32,768 decoded characters, 12 JSON nesting levels,
2,048 JSON values, 64 statements, 128 array entries and 2,048 characters per JSON
string. The 6,144 managed-policy character count uses the existing bootstrap
test convention of compact JSON excluding whitespace. Extra parsing bounds
can conservatively report conflict for otherwise valid unusually padded policy
documents. The standard SDK/runner transport must honor the abort signal;
session expiry/revocation remains enforced by the existing session guard. No
timer or readback can make concurrent IAM reads an atomic authorization proof.
No raw document, tag value, SDK exception text, credentials or child-process
environment is returned or logged. Diagnostics use fixed codes and validated
non-secret identity fields only.

## Stack-first migration

The deterministic checklist first confirms the saved account/region/suffix with
the owning stack outputs. The customer stack owner reviews and updates the
existing CloudFormation stack or bootstrap OpenTofu module before workload
migration, preserving the legacy policy and parameters. Preflight is repeated
after that update. Unavailable and conflicting reads must be resolved. A native
approved environment plan then moves each owned role directly to its exact
family boundary. Role replacements from old truncation or suffix names require
review. The legacy boundary remains attached until that role's reviewed apply
replaces it; there is no unbounded, detached intermediate state. Retirement is
solely a customer-administrator decision after an independent account-wide
inventory of every legacy-boundary user and role. This helper cannot establish
zero remaining uses. Independent authorization acceptance is still required.

## Exact bootstrap read prerequisite and outside-owned integration

The helper is not integrated into the default credential/execution flow. The
prior bootstrap observe policy's `ReadZenithIam` resources included only
lowercase `policy/zenith-*`, while the six canonical boundary names and retained
legacy name start with `Zenith`. The existing narrowed observe session permits
role reads but omits `GetPolicy` and `GetPolicyVersion`. These were identified
before editing any policy. Root explicitly authorized a bounded ownership
expansion for the exact read-only stack prerequisite and a dedicated narrower
session-policy factory in the owned helper. No fallback to a deploy session,
session-policy bypass or broad IAM allowance was added.

The authoritative stack source now adds one `ReadBootstrapBoundaryVersions`
Allow to `deploy/aws/zenith-connection.cfn.yaml` for only `iam:GetPolicy` and
`iam:GetPolicyVersion`, using the exact seven managed-policy resource Refs:
`AppBoundary`, `BuildBoundary`, `MachineBoundary`, `SchedulerBoundary`,
`EksClusterBoundary`, `EksNodeBoundary` and `WorkloadBoundary`. Only the affected
`deploy/aws/tofu-module/policies/observe.json.tftpl` was regenerated using the unchanged
`deploy/aws/tools/generate-tofu-policies.ts` pipeline. Its seven reference
overrides and `deploy/aws/tofu-module/main.tf` policy variables already preserve
the exact account/partition/suffix. All existing observe, deploy and family
grants and denies remain exact. Authorized source generation confirmed the other
17 generated templates byte-for-byte and every prior parsed bootstrap resource
and statement after removing the one additive read statement. The existing
bootstrap test now pins that prepared Resources SHA256 and exact read actions,
seven ARNs, foreign identity refusals and policy size constraints across all
three rendered partitions and empty, ordinary and maximal suffixes. Tests and
independent tool acceptance are still unrun.
The source-generation receipt records ambient Node 24.5.0 solely for this
authorized deterministic authoring command; it is not the required pinned
Node 22.23.3 compiler, test or tool acceptance.

An owning preflight callback in `src/lib/execution/session.ts`, with the native
connection resolved by `src/lib/platform/credentials.ts`, must bind verified
connection/workspace/environment and native role identities, request the
existing approved observe authority, and invoke this helper only inside that
broker callback. The existing `CredentialRequest.sessionPolicy` supports the
owned `awsBootstrapPreflightSessionPolicy` factory's narrower read policy. This
factory accepts the same saved connection and captured native inventory, derives
only the exact seven policy ARNs plus exact role ARNs, and uses the existing STS
validator to refuse anything above 2,048 compact characters before a broker
request. The 32-role inspection bound does not guarantee that every such
inventory fits the narrower session policy; an oversized inventory refuses and
needs a separately reviewed bounded invocation strategy. No selector or client
constructor can override the scope. The default observe session policy and
broker API remain unchanged. Native owning broker tests need separate review
before integration; no new capability or caller-provided authority is needed.
Mandatory CI registration, if this becomes an owning production prerequisite,
belongs in the canonical gate manifest with exact named checks and no skip waiver.

## Primary AWS references and root verification

Current IAM API documentation was checked at implementation time. Metadata and
the default-version document come from separate read APIs:
[GetPolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetPolicy.html)
and [GetPolicyVersion](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetPolicyVersion.html).
The [Policy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_Policy.html)
and [PolicyVersion](https://docs.aws.amazon.com/IAM/latest/APIReference/API_PolicyVersion.html)
contracts describe stable IDs, default markers, version identifiers and RFC 3986
document encoding. [GetRole](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html)
provides role identity and attached boundary readback.
[IAM quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
defines the managed-policy size ceiling. AWS
[permissions boundary documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
explains why boundary readback alone cannot establish effective permissions.

All compiler, scoped ESLint, affected credential/bootstrap tests and actual
independent OpenTofu verification remain unrun. `VERIFICATION-COMMANDS.json` in
the freeze directory lists precise root-owned commands with pinned Node 22.23.3
and explicit one-worker execution. A dependency symlink is reuse only, never
fresh-install evidence. Root must review this frozen source, run those checks
serially and arrange independent live IAM acceptance under separate explicit
customer authority before claiming production integration or LIFE-03 completion.
