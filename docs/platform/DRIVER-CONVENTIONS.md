# Resource driver conventions

Every provider's drivers follow these rules so AWS, Kubernetes, GCP, Azure,
OCI and `zenith` stay interchangeable behind `src/lib/drivers/types.ts`.

## Layout and registration

- `src/lib/providers/<provider>/drivers/<group>/<name>.ts` — one driver per
  file, exporting a `ResourceDriver<Session>` constant.
- `src/lib/providers/<provider>/drivers/<group>/index.ts` exports the group's
  drivers as an array. The provider-level `drivers/index.ts` (owned by the
  orchestrator at integration) concatenates groups and exposes an idempotent
  `register<Provider>Drivers()`.
- `id` = `<provider>.<suffix>@1` (e.g. `aws.ecs_service@1`); `nativeType`
  exactly the string from `src/lib/resources/native-types.ts`; `kind` the
  portable kind. One driver may serve two kinds that share a native type
  (`aws:rds_instance` serves postgres and mysql) by reading `spec.engine`.
- Specs are read through the typed interfaces in
  `src/lib/resources/specs.ts`. Never read a key that is not in the spec
  contract; if a driver needs more, propose an additive spec field.

## Compile (OpenTofu JSON)

- Pure and deterministic; no I/O, no clock, no randomness (use tofu
  `random_*` resources when a random value is needed).
- tofu resource names: `ctx.namePrefix`-free *labels* derived from the node
  address, sanitized to `[a-z0-9_]` (`service/web` → `service_web`); suffixes
  for multiple resources per node (`service_web_task`, `service_web_svc`).
  Every label is listed in `TofuFragment.addresses` as `<type>.<label>`.
- Cloud-side names: `${ctx.namePrefix}-<node-name>` truncated to the
  provider's limit with a deterministic 6-hex fnv1a suffix when truncated.
- Every taggable resource carries `ctx.tags` (AWS `tags`, GCP `labels`
  lowercased/sanitized, Azure `tags`, k8s labels/annotations).
- References to other nodes use `ctx.ref(address, attribute)`; never
  hard-code another node's tofu label.
- Stateful resources: `deletion_protection = true` (or the provider's
  equivalent) unless `spec.deletionPolicy === "allow"`; final snapshot on
  delete; encryption on; never publicly accessible; backups per
  `spec.backup`.
- IAM: least privilege from `IdentitySpec.grants` only — exact resource
  ARNs/ids via `ctx.ref`, explicit actions, never `"*"` actions or resources
  (policy will deny wildcard IAM). Roles Zenith creates carry the
  `ZenithWorkloadBoundary` permission boundary (AWS).
- Secrets: compile references only (Secrets Manager/SSM ARN, Secret Manager
  resource name, Key Vault secret id). No secret value is ever in a
  fragment. Generated credentials (DB master password) use the provider's
  managed secret feature (e.g. RDS `manage_master_user_password`), not
  `random_password` in state, where the provider supports it.
- `referenced` / `external` nodes compile to `data` sources at most — never
  `resource` blocks (the workspace assembler rejects them).

## Cross-node references

The execution compiler implements `ctx.ref(target, attribute)` with one rule:

1. Compile the target on demand. A reference cycle is an error, even when the
   target would publish a local. An external node contributes no fragment.
2. If its fragment declares the own local `refLocalName(target, attribute)`,
   return `${local.<that name>}`. Published locals take precedence even for
   native attributes such as `id` or `arn` (e.g. an ACM validated ARN).
3. Otherwise, accept only an identifier path with optional numeric indexes
   (`id`, `metadata[0].name`) and return `${<primary address>.<attribute>}`.
   The primary address is a resource with the sanitized node label, else the
   first resource address, else the matching/first data address.
4. Refuse invalid keys, unpublished semantic keys, or a target without an
   address. Errors name the source node, target and attribute with bounded,
   sanitized text; arbitrary manifest text never becomes an expression.

Published reference keys use ASCII letters, digits, `_`, `-`, `.`, `/`, `:`,
`[` and `]`, start with a letter or `_`, and are at most 512 characters.
Colons/slashes are lookup syntax only: `target_group_arn:container_service/web:3000`
and `private_route_table_id:a` require declared locals. Traversal fallback
allows identifier segments starting with a letter or `_`, optional numeric
indexes, and dots; no functions, quoted indexes, splats or template syntax.

`refLocalName` currently lives in
`src/lib/providers/aws/drivers/shared/refs.ts` and is reused unchanged by the
execution compiler: `ref_<tfLabel(target)>__<normalized attribute>`. Attribute
normalization lowercases and replaces each non-`[a-z0-9_]` character with `_`.
The label helper preserves the AWS hash/truncation convention; this is not
the compiler's simpler primary-address label sanitizer.

AWS publishes these locals, including attributes absent from its primary
resource. OCI and GCP use primary-resource traversals for `ctx.ref`; OCI's
compile calls additionally require `ociCompileContext` with the connection's
non-secret compartment/tenancy identifiers. OCI's auxiliary locals and
Azure's export locals are referenced directly through their provider helpers;
Azure has no live `ctx.ref` call. Kubernetes and `zenith` do not compile via
this path. Provider-schema validation is separate from reference resolution;
the opt-in OpenTofu tests do not prove a cloud deploy succeeds.

Current integration limits exposed by `tests/execution/compile-refs-providers.test.ts`:
the full AWS staging/production graphs have a compile-reference cycle between
the VPC NAT gateway's subnet lookup (`network/vpc-compile.ts:137`) and the
subnet's VPC lookup (`network/subnet.ts:83`). The cycle guard deliberately
refuses these graphs. OCI's expanded fixture is refused by its identity
driver's missing Redis grant mapping (`oci/drivers/platform/identity.ts:108`);
expanded GCP database grants include `read_credentials`, which is refused by
`gcp/iam-roles.ts:81`. Those driver/expansion changes remain outside WS-REF;
the full-graph acceptance tests stay strict and expose the refusals.

## Observe / runtime / verify / discover

- Read-only native API calls through `ctx.session` (`AwsSession.client()`,
  `GcpSession.authorizedFetch`, …). Never construct credentials.
- Find the object by `externalId` when known, else by the Zenith tags
  (`zenith:environment` + `zenith:resource`) — never by name alone.
- Report only attributes actually read, as `ObservedValue` `known`;
  everything else `unknown` with a reason. `presence`: `present` / `missing`
  (API said not found) / `inaccessible` (access denied) / `unknown` (error).
- Keep a bounded (≤ 4 KiB), redacted `native` bag of useful raw fields.
- `expectedAttributes(node)` returns exactly the attribute names `observe`
  reads, in the same units, so drift compares like with like.
- `verify` checks: exists, configuration matches expected attributes,
  and for serving resources that it is healthy/serving (target health,
  steady state, endpoint status).
- `discover` lists candidates, marks `zenithTagged`, never adopts.
- Honour `ctx.signal`; paginate with a bounded page count.

## Day-two operations

- Keyed by capability name from `src/lib/capabilities/catalog.ts`.
- Idempotent: use provider idempotency/client tokens derived from
  `ctx.operationId`; pass the fence token as a request tag/token where the
  API allows; re-check before acting that the target carries the Zenith
  tags for this environment.
- Return bounded, redacted, model-safe `data`; include provider request ids.

## Evidence and tests

- Each driver declares `capabilities.evidence` honestly: without a live
  account everything is `contract` (mocked SDK/HTTP). Never `real` unless a
  live acceptance run proved it.
- Tests under `tests/providers/<provider>/drivers/**`:
  - compile: golden-ish structural assertions + assemble with
    `assembleWorkspace` and run `tofu validate` (gated behind
    `ZENITH_TEST_TOFU_NETWORK=1` when provider download is needed; the plugin
    cache makes repeat runs fast);
  - observe/runtime/verify/discover: mocked SDK (`aws-sdk-client-mock`) or a
    local fake HTTP server, covering present / missing / access denied /
    throttled / partial data;
  - no secret value in any fragment, observation, or error (canary tests);
  - no wildcard IAM in any compiled policy;
  - determinism (compile twice → identical JSON).
