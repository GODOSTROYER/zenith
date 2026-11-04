/**
 * WS-SEC shared security-test helpers. Import from `../_support/security`.
 *
 *   canaries.ts       canarySecret / canarySet, deepScanForCanaries, expectNoCanaries
 *   tenant-matrix.ts  tenantMatrix (principals x targets), refused(), assertIsolated
 *   corpus.ts         injectionCorpus, injectionsFor(category…)
 *   fixtures.ts       twoTenantFixture (pure data, canaries planted per tenant)
 *   coverage.ts       measureCoverage / expectCoverage (redaction coverage ratchet)
 *   driver-inert.ts   assertDriverStringsInert (every driver compile() must run it)
 *   runtime.ts        jsonParseKeyBug / skipIfJsonParseBroken (engine defects a test must not depend on)
 *   policy.ts         (import directly) policyInputFor and the principal/role/origin enumerations
 *
 * See `tests/security/README.md` for how a new module plugs in.
 */
export * from "./canaries";
export * from "./corpus";
export * from "./coverage";
export * from "./driver-inert";
export * from "./fixtures";
export * from "./runtime";
export * from "./tenant-matrix";
