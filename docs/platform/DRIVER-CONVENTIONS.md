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
