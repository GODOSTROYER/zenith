/**
 * SNAPSHOT of WS-AWS-NET's `src/lib/providers/aws/drivers/shared/**` (branch
 * ws/aws-net, commit 123f0f5 plus its working-tree changes at 2026-09-30, re-sync before handoff), copied verbatim into this group because the
 * compute branch cannot import a module that only exists on another branch.
 *
 * CONSOLIDATION: delete this directory and change `./aws-shared` imports in
 * `compute/**` to `@/lib/providers/aws/drivers/shared`. Do not edit these
 * files here; change them in shared/ and re-copy.
 */
/**
 * AWS-wide driver helpers. Other AWS driver groups (compute, data) import from
 * here, never from the network group:
 *
 *   names.ts           fnv1a/hash6, tfLabel, cloudName, nodeName, addressSlug
 *   tags.ts            tag constants, toAwsTagList/fromAwsTagList, resourceTags,
 *                      isZenithTagged/matchesNodeTags, ec2TagFilters
 *   errors.ts          classifyAwsError (AccessDenied → inaccessible, NotFound →
 *                      missing, Throttling → unknown), DriverCompileError
 *   paginate.ts        bounded paginate(), chunk()
 *   arn.ts             parseArn, elbv2ArnSuffix, partitionOfRegion
 *   observe.ts         Observation/RuntimeState builders, boundNative
 *   refs.ts            the cross-node reference protocol (refLocalName, REF, …)
 *   fragment.ts        FragmentBuilder
 *   topology.ts        subnetsOf, networkAddressOf
 *   security-group.ts  the one-security-group-per-node contract
 *   verify.ts          existsCheck, attributeChecks, standardVerification
 */
export * from "./names";
export * from "./tags";
export * from "./errors";
export * from "./paginate";
export * from "./arn";
export * from "./observe";
export * from "./refs";
export * from "./fragment";
export * from "./topology";
export * from "./security-group";
export * from "./verify";
