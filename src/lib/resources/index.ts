/**
 * Resource model, one door: `@/lib/resources`.
 *
 *   types            desired / observed / runtime state (the contract)
 *   manifest-v2      Manifest V2 schema, parseManifest, native-type registry
 *   upgrade          V1 → V2 and back, lossless
 *   expand           manifest → portable ResourceGraph
 *   drift            drift v2 over graph + observations
 *   native-types     the portable-kind → native-type table drivers share
 *
 * Pure (L0): no fs, no env, no store.
 */
export * from "./types";
export * from "./specs";
export {
  ConcreteProvider,
  Constraints,
  ManifestV2,
  ManifestV2Object,
  MigrateHook,
  Release,
  NativeNode,
  NodePlacementEntry,
  Placement,
  PlacementProvider,
  PLACEMENT_PROVIDERS,
  PoliciesV2,
  ProviderConfig,
  AwsConfig,
  AzureConfig,
  GcpConfig,
  KubernetesConfig,
  OciConfig,
  RegionName,
  isV1,
  isV2,
  parseManifest,
  resolvePolicies,
  type AnyManifest,
  type EffectivePolicies,
  type ManifestIssue,
  type ParseManifestResult,
} from "./manifest-v2";
export {
  findNativeType,
  isNativeTypeRegistered,
  listNativeTypes,
  parseNativeConfig,
  registerNativeType,
  unregisterNativeType,
  type NativeConfigResult,
  type NativeTypeEntry,
} from "./native-registry";
export {
  NATIVE_PREFIX,
  NATIVE_TYPE_TABLE,
  isUnsupportedNativeType,
  kindsForNativeType,
  nativeTypeFor,
  resolveNativeType,
  unsupportedNativeType,
} from "./native-types";
export {
  downgradeToV1,
  upgradeManifest,
  upgradeManifestDetailed,
  v1View,
  v2OnlySections,
  type UpgradeResult,
  type UpgradeTarget,
} from "./upgrade";
export { expandManifest, ManifestExpansionError, manifestDigest, type ExpandEnv } from "./expand";
export { graphDigestOf, specDigestOf, canonicalManifest } from "./expand-support";
export { computeDriftV2, defaultExpectedAttributes, type DriftOptions, type ExpectedAttributes } from "./drift";
export { findInlineSecretPaths, looksSecretKey, stripUrlCredentials, urlHasCredentials } from "./secrets";
export { EcsReplicaRepairInput, ecsReplicaRepairRecipe, supportsDeclarativeRepair, type EcsReplicaRepairInputV1, type EcsReplicaRepairRecipeV1 } from "./repair-recipes";
