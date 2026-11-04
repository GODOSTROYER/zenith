/**
 * Test drivers. A driver here is a real `ResourceDriver` (same contract, same
 * call sites in the activities) whose behaviour is scripted. NOT a simulation of
 * AWS: `compile` emits the built-in `terraform_data` resource so the REAL OpenTofu
 * engine can plan and apply it without a cloud, and `observe`/`verify` answer
 * whatever the test scripted.
 */
import type { CompileContext, DriverContext, NativeOperation, ResourceDriver, VerificationResult } from "@/lib/drivers/types";
import type { Observation, ProviderKey, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { sanitizeLabel } from "@/lib/execution/compile";
import type { DriverLookup } from "@/lib/execution/ports";

export interface DriverScript {
  /** observe/verify behaviour by node address */
  observe?: (ctx: DriverContext, node: ResourceNode, externalId?: string) => Promise<Observation>;
  runtime?: (ctx: DriverContext, node: ResourceNode) => Promise<RuntimeState>;
  verify?: (ctx: DriverContext, node: ResourceNode, observation: Observation) => Promise<VerificationResult>;
  expectedAttributes?: (node: ResourceNode) => Record<string, unknown>;
  operations?: Record<string, NativeOperation>;
  /** omit `verify`/`observe` entirely (a driver that declares it cannot) */
  omit?: ("observe" | "runtime" | "verify" | "compile")[];
  /** tofu resource extras merged into terraform_data (e.g. a sensitive input, or a `ctx.ref(...)`) */
  compileExtra?: (node: ResourceNode, ctx: CompileContext) => Record<string, unknown>;
  /** called with what the driver was handed at compile time */
  onCompile?: (node: ResourceNode, ctx: CompileContext) => void;
}

export const presentObservation = (ctx: Pick<DriverContext, "now">, node: ResourceNode, attributes: Observation["attributes"] = {}): Observation => ({
  address: node.address,
  presence: "present",
  attributes,
  externalId: `ext-${sanitizeLabel(node.address)}`,
  observedAt: ctx.now().toISOString(),
  source: "test.driver@1",
  simulated: false,
});

export const passedVerification = (ctx: Pick<DriverContext, "now">, node: ResourceNode): VerificationResult => ({
  address: node.address,
  status: "passed",
  checks: [{ id: "exists", description: "the resource exists", passed: true }],
  checkedAt: ctx.now().toISOString(),
  simulated: false,
});

export function testDriver(provider: ProviderKey, nativeType: string, script: DriverScript = {}): ResourceDriver {
  const omit = new Set(script.omit ?? []);
  const driver: ResourceDriver = {
    id: `test.${nativeType.replace(/[^a-z0-9]+/gi, "_")}@1`,
    provider,
    kind: "provider_native",
    nativeType,
    capabilities: {
      compile: !omit.has("compile"),
      observe: !omit.has("observe"),
      runtime: !omit.has("runtime"),
      verify: !omit.has("verify"),
      discover: false,
      operations: Object.keys(script.operations ?? {}),
      evidence: { compile: "contract", observe: "contract", verify: "contract" },
    },
  };
  if (!omit.has("compile")) {
    driver.compile = (node, ctx) => {
      script.onCompile?.(node, ctx);
      if (node.ownership !== "managed") return { addresses: [] };
      const label = sanitizeLabel(node.address);
      return {
        resource: { terraform_data: { [label]: { input: node.specDigest, ...(script.compileExtra?.(node, ctx) ?? {}) } } },
        addresses: [`terraform_data.${label}`],
      };
    };
  }
  if (!omit.has("observe")) driver.observe = script.observe ?? (async (ctx, node) => presentObservation(ctx, node));
  if (!omit.has("runtime"))
    driver.runtime =
      script.runtime ??
      (async (ctx, node) => ({ address: node.address, health: "healthy", counts: {}, signals: [], observedAt: ctx.now().toISOString(), source: "test.driver@1", simulated: false }));
  if (!omit.has("verify")) driver.verify = script.verify ? (ctx, node, observation) => script.verify!(ctx, node, observation) : async (ctx, node) => passedVerification(ctx, node);
  if (script.expectedAttributes) driver.expectedAttributes = script.expectedAttributes;
  if (script.operations) driver.operations = script.operations;
  return driver;
}

/**
 * A lookup that answers for EVERY (provider, nativeType) with a generic driver,
 * except where `overrides` names a nativeType (or `missing` lists one that has
 * no driver at all).
 */
export function genericDrivers(opts: { script?: DriverScript; overrides?: Record<string, DriverScript>; missing?: string[] } = {}): DriverLookup & { cache: Map<string, ResourceDriver> } {
  const cache = new Map<string, ResourceDriver>();
  const lookup = ((provider: ProviderKey, nativeType: string): ResourceDriver | undefined => {
    if (opts.missing?.includes(nativeType)) return undefined;
    const key = `${provider}|${nativeType}`;
    let d = cache.get(key);
    if (!d) {
      d = testDriver(provider, nativeType, { ...opts.script, ...opts.overrides?.[nativeType] });
      cache.set(key, d);
    }
    return d;
  }) as DriverLookup & { cache: Map<string, ResourceDriver> };
  lookup.cache = cache;
  return lookup;
}
