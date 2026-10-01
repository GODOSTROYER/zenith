/**
 * SNAPSHOT, NOT THE SOURCE OF TRUTH. This directory is a verbatim copy of
 * WS-AWS-NET's `src/lib/providers/aws/drivers/shared/**` at their commit
 * 123f0f5 (branch ws/aws-net), taken so the data drivers compile and test on
 * this branch alone (the rule is: do not write into `shared/`, do not merge
 * another worker's branch). Only this header differs from that commit.
 *
 * AT INTEGRATION: delete this directory and change every
 * `from "./_shared"` under `drivers/data/` (and the
 * `"@/lib/providers/aws/drivers/data/_shared"` imports in the tests) to the
 * real `shared/` path. The data drivers use only the API documented below.
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
