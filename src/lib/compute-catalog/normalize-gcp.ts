import type { ComputeOffer, RawComputeSnapshot } from "./types";
import { architecture, decimalText, decimalUnits, effectiveTime, googleMoney, isFutureOrInvalid, object, offerId, positiveInteger, resolvePrice, rows, source, text, type ObjectValue, type PriceCandidate, type ProviderNormalization } from "./normalize-common";

// These are public Compute Engine SKU labels, not inferred prices or generic VM aliases.
// https://cloud.google.com/skus/sku-groups/on-demand-vms
// https://cloud.google.com/skus/sku-groups/on-demand-t2a-vms
const FAMILY_METERS: readonly [string, RegExp][] = [
  ["e2", /^E2 Instance (Core|Ram) running in /i],
  ["n1", /^N1 Predefined Instance (Core|Ram) running in /i],
  ["n2", /^N2 Instance (Core|Ram) running in /i],
  ["n2d", /^N2D AMD Instance (Core|Ram) running in /i],
  ["t2d", /^T2D AMD Instance (Core|Ram) running in /i],
  ["t2a", /^T2A Arm Instance (Core|Ram) running in /i],
];

function machineRows(snapshot: RawComputeSnapshot): { machine: ObjectValue; zone?: string }[] {
  const data = object(snapshot.data);
  const warning = object(data.warning);
  if (warning.code && warning.code !== "NO_RESULTS_ON_PAGE") throw new Error(`Incomplete GCP machine inventory: ${String(warning.code)}.`);
  if (Array.isArray(data.items)) {
    const pathZone = new URL(snapshot.url).pathname.match(/\/zones\/([^/]+)\/machineTypes\/?$/)?.[1];
    return rows(data.items).map(machine => ({ machine, zone: text(machine.zone)?.split("/").at(-1) ?? pathZone }));
  }
  if (data.items !== undefined && (!data.items || typeof data.items !== "object")) throw new Error("GCP machine type snapshots require an aggregated items object or a zonal items array.");
  if (data.items === undefined) {
    // Native APIs omit an empty repeated field. An explicit list kind distinguishes that from malformed input.
    if (data.kind === "compute#machineTypeList" || data.kind === "compute#machineTypeAggregatedList") return [];
    throw new Error("GCP machine type snapshot has no native items collection.");
  }
  const result: { machine: ObjectValue; zone?: string }[] = [];
  for (const [scope, scopedValue] of Object.entries(object(data.items))) {
    const scoped = object(scopedValue);
    const warning = object(scoped.warning);
    if (warning.code && warning.code !== "NO_RESULTS_ON_PAGE") throw new Error(`Incomplete GCP machine inventory: ${String(warning.code)}.`);
    if (scoped.machineTypes !== undefined && !Array.isArray(scoped.machineTypes)) throw new Error("GCP scope machineTypes must be an array.");
    const scopeZone = scope.startsWith("zones/") ? scope.slice(6) : undefined;
    for (const machine of rows(scoped.machineTypes)) result.push({ machine, zone: text(machine.zone)?.split("/").at(-1) ?? scopeZone });
  }
  return result;
}

/** Native machine types are retained even when their billing composition is not implemented. */
export function normalizeGcpSnapshots(snapshots: readonly RawComputeSnapshot[], asOf: string): ProviderNormalization {
  const prices = new Map<string, PriceCandidate[]>();
  const warnings: string[] = [];
  let unsupportedPrices = 0;
  const componentKey = (region: string, family: string, component: string) => `${region}:${family}:${component}`;
  for (const snapshot of snapshots.filter(s => s.kind === "gcp_skus")) {
    const data = object(snapshot.data);
    if (!Array.isArray(data.skus)) throw new Error("GCP billing snapshots require a native skus array.");
    const evidence = source(snapshot);
    for (const sku of rows(data.skus)) {
      const category = object(sku.category);
      if (category.usageType !== "OnDemand" || category.serviceDisplayName !== "Compute Engine" || category.resourceFamily !== "Compute") continue;
      const description = text(sku.description) ?? "";
      const rule = FAMILY_METERS.find(([, pattern]) => pattern.test(description));
      if (!rule) continue;
      const component = rule[1].exec(description)![1]!.toLowerCase() === "core" ? "cpu" : "memory";
      const nativeSku = text(sku.skuId) ?? text(sku.name)?.split("/").at(-1);
      const regions = Array.isArray(sku.serviceRegions) ? sku.serviceRegions.filter((r): r is string => typeof r === "string" && r.length > 0) : [];
      if (!nativeSku || !regions.length) { unsupportedPrices++; continue; }
      for (const pricingInfo of rows(sku.pricingInfo)) {
        if (isFutureOrInvalid(pricingInfo.effectiveTime, asOf)) continue;
        const expression = object(pricingInfo.pricingExpression);
        const tiers = rows(expression.tieredRates);
        const amount = tiers.length === 1 ? googleMoney(tiers[0]!.unitPrice) : undefined;
        const expectedUnit = component === "cpu" ? "h" : "GiBy.h";
        const supported = expression.usageUnit === expectedUnit && tiers.length === 1 && Number(tiers[0]!.startUsageAmount ?? 0) === 0 && amount !== undefined;
        if (!supported) unsupportedPrices++;
        const effectiveAt = effectiveTime(pricingInfo.effectiveTime, asOf);
        const candidate: PriceCandidate = { amount: supported ? amount! : null, source: evidence, nativeSku, ...(effectiveAt ? { effectiveAt } : {}) };
        for (const region of regions) {
          if (snapshot.region && region !== snapshot.region) continue;
          const key = componentKey(region, rule[0], component);
          const candidates = prices.get(key) ?? [];
          candidates.push(candidate);
          prices.set(key, candidates);
        }
      }
    }
  }

  const offers: ComputeOffer[] = [];
  let invalidShapes = 0;
  let unsupportedCompositions = 0;
  for (const snapshot of snapshots.filter(s => s.kind === "gcp_machine_types")) {
    const evidence = source(snapshot);
    const data = object(snapshot.data);
    if (Array.isArray(data.unreachables) && data.unreachables.length) throw new Error("GCP machine inventory has unreachable scopes; import a complete successful result.");
    for (const { machine, zone } of machineRows(snapshot)) {
      const instanceType = text(machine.name);
      const vcpus = positiveInteger(machine.guestCpus);
      const memoryMiB = positiveInteger(machine.memoryMb);
      const region = zone?.match(/^(.+\d)-[a-z]$/)?.[1];
      if (!instanceType || !vcpus || !memoryMiB || !region || !zone) { invalidShapes++; continue; }
      if (snapshot.region && snapshot.region !== region) throw new Error("GCP machine region does not match its snapshot scope.");
      const family = instanceType.split("-")[0]!;
      const shared = machine.isSharedCpu === true || /^(?:e2-(?:micro|small|medium)|f1-micro|g1-small)$/.test(instanceType);
      const cpuMode = shared ? "shared" as const : machine.isSharedCpu === false ? "sustained" as const : "unknown" as const;
      const offerWarnings: string[] = [];
      const deprecatedState = text(object(machine.deprecated).state);
      if (deprecatedState && deprecatedState !== "ACTIVE") offerWarnings.push(`The imported machine type has deprecation state ${deprecatedState}.`);
      let price: ComputeOffer["price"] = null;
      // Shared-core, custom, GPU, and newer family pricing can have different meters or premiums.
      const supported = !shared && /^(?:e2|n1|n2|n2d|t2d|t2a)-(?:standard|highmem|highcpu)-\d+$/.test(instanceType);
      if (!supported) {
        unsupportedCompositions++;
        offerWarnings.push("This native machine type is retained, but its shared-core, custom, accelerator, or family billing composition is not supported yet.");
      } else {
        const cpu = resolvePrice(prices.get(componentKey(region, family, "cpu")) ?? []);
        const ram = resolvePrice(prices.get(componentKey(region, family, "memory")) ?? []);
        if (cpu.price && ram.price) {
          const cpuAmount = decimalUnits(cpu.price.hourlyUsd)! * BigInt(vcpus);
          const memoryNumerator = decimalUnits(ram.price.hourlyUsd)! * BigInt(memoryMiB);
          if (memoryNumerator % 1024n !== 0n) {
            offerWarnings.push("The composed memory price exceeds supported decimal precision; it was not rounded.");
          } else {
            // Use the older component's retrieval time so combined-price freshness cannot hide stale input.
            const evidence = Date.parse(cpu.price.source.retrievedAt) <= Date.parse(ram.price.source.retrievedAt) ? cpu.price.source : ram.price.source;
            const effectiveAt = [cpu.price.effectiveAt, ram.price.effectiveAt].filter((t): t is string => !!t).sort().at(-1);
            price = {
              hourlyUsd: decimalText(cpuAmount + memoryNumerator / 1024n), source: evidence,
              nativeSku: `${cpu.price.nativeSku}+${ram.price.nativeSku}`,
              ...(effectiveAt ? { effectiveAt } : {}),
            };
            offerWarnings.push(`Composed from CPU SKU ${cpu.price.nativeSku} (snapshot ${cpu.price.source.sha256}) and RAM SKU ${ram.price.nativeSku} (snapshot ${ram.price.source.sha256}); both sources are retained in the catalog.`);
          }
        } else {
          if (cpu.warning) offerWarnings.push(`CPU: ${cpu.warning}`);
          if (ram.warning) offerWarnings.push(`RAM: ${ram.warning}`);
        }
      }
      const arch = architecture(machine.architecture);
      if (arch === "unknown") offerWarnings.push("CPU architecture is not established by the supplied machine metadata.");
      if (cpuMode === "unknown") offerWarnings.push("CPU sharing behavior is not established by the supplied machine metadata.");
      offers.push({
        id: offerId("gcp", region, instanceType, zone), provider: "gcp", region, zone, instanceType,
        vcpus, memoryMiB, architecture: arch, cpuMode, operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
        price, specSource: evidence, offeringState: deprecatedState === "OBSOLETE" || deprecatedState === "DELETED" ? "catalog_only" : "offered", warnings: offerWarnings,
      });
    }
  }
  if (invalidShapes) warnings.push(`${invalidShapes} GCP records lacked supported CPU, memory, type, or zone fields and could not produce a comparable shape.`);
  if (unsupportedPrices) warnings.push(`${unsupportedPrices} GCP component price versions used unsupported currencies, units, tiers, or amounts and were not treated as free.`);
  if (unsupportedCompositions) warnings.push(`${unsupportedCompositions} native GCP offers have an unsupported billing composition and remain unpriced.`);
  if (!snapshots.some(s => s.kind === "gcp_machine_types") && snapshots.some(s => s.kind === "gcp_skus")) warnings.push("GCP billing SKUs contain no authoritative machine inventory; import machineTypes to construct offers.");
  return { offers, warnings };
}
