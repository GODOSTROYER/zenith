import type { ComputeCpuMode, ComputeOffer, RawComputeSnapshot } from "./types";
import { USD_SCALE, architecture, decimalUnits, effectiveTime, isFutureOrInvalid, object, offerId, positiveInteger, resolvePrice, rows, source, text, type ObjectValue, type PriceCandidate, type ProviderNormalization } from "./normalize-common";

function capabilities(sku: ObjectValue): ObjectValue {
  return Object.fromEntries(rows(sku.capabilities).filter(c => typeof c.name === "string").map(c => [String(c.name), c.value]));
}

function memoryMiB(value: unknown): number | undefined {
  const amount = decimalUnits(value);
  if (amount === undefined || (amount * 1024n) % USD_SCALE !== 0n) return undefined;
  return positiveInteger(Number(amount * 1024n / USD_SCALE));
}

function cpuMode(sku: ObjectValue): ComputeCpuMode {
  const family = text(sku.family) ?? "";
  // B-series are explicitly burstable. Other known regular VM families are sustained;
  // future or unrecognized families stay unknown instead of inheriting a naming guess.
  if (/^standardB.*Family$/i.test(family)) return "burstable";
  if (/^standard(?:D|E|F|L|M|N|H|A|DC|EC).+Family$/i.test(family) || /^basicAFamily$/i.test(family)) return "sustained";
  return "unknown";
}

function restrictionFor(sku: ObjectValue, region: string, zone?: string): boolean {
  for (const restriction of rows(sku.restrictions)) {
    const info = object(restriction.restrictionInfo);
    const locations = Array.isArray(info.locations) ? info.locations : restriction.type === "Location" && Array.isArray(restriction.values) ? restriction.values : [];
    const matchesRegion = locations.length === 0 || locations.includes(region);
    if (!matchesRegion) continue;
    if (restriction.type === "Location") return true;
    if (restriction.type === "Zone") {
      const zones = Array.isArray(info.zones) ? info.zones : [];
      if (zone === undefined || zones.length === 0 || zones.includes(zone)) return true;
    }
  }
  return false;
}

/** Joins ARM resource-SKU capabilities and restrictions with public Retail Prices meters. */
export function normalizeAzureSnapshots(snapshots: readonly RawComputeSnapshot[], asOf: string): ProviderNormalization {
  const prices = new Map<string, PriceCandidate[]>();
  const warnings: string[] = [];
  let unsupportedPrices = 0;
  const key = (region: string, instanceType: string) => `${region}:${instanceType}`;
  for (const snapshot of snapshots.filter(s => s.kind === "azure_retail_prices")) {
    const data = object(snapshot.data);
    if (!Array.isArray(data.Items)) throw new Error("Azure retail snapshots require a native Items array.");
    const evidence = source(snapshot);
    for (const item of rows(data.Items)) {
      if (item.serviceName !== "Virtual Machines" || item.type !== "Consumption" || item.isPrimaryMeterRegion === false) continue;
      const labels = `${text(item.productName) ?? ""} ${text(item.skuName) ?? ""} ${text(item.meterName) ?? ""}`;
      if (!/^Virtual Machines\b/i.test(text(item.productName) ?? "") || /Windows|\bSQL\b|Red Hat|\bRHEL\b|\bSUSE\b|Ubuntu Pro|Spot|Low Priority|LowPriority|Cloud Services/i.test(labels)) continue;
      const region = text(item.armRegionName);
      const instanceType = text(item.armSkuName);
      const nativeSku = text(item.meterId) ?? text(item.skuId);
      if (!region || !instanceType || !nativeSku) { unsupportedPrices++; continue; }
      if (snapshot.region && region !== snapshot.region) throw new Error("Azure retail region does not match its snapshot scope.");
      if (isFutureOrInvalid(item.effectiveStartDate, asOf)) continue;
      const amount = decimalUnits(item.retailPrice);
      const supported = item.currencyCode === "USD" && item.unitOfMeasure === "1 Hour" && Number(item.tierMinimumUnits ?? 0) === 0 && amount !== undefined;
      if (!supported) unsupportedPrices++;
      const effectiveAt = effectiveTime(item.effectiveStartDate, asOf);
      const candidates = prices.get(key(region, instanceType)) ?? [];
      candidates.push({ amount: supported ? amount! : null, nativeSku, source: evidence, ...(effectiveAt ? { effectiveAt } : {}) });
      prices.set(key(region, instanceType), candidates);
    }
  }

  const offers: ComputeOffer[] = [];
  let invalidShapes = 0;
  for (const snapshot of snapshots.filter(s => s.kind === "azure_resource_skus")) {
    const data = object(snapshot.data);
    if (!Array.isArray(data.value)) throw new Error("Azure resource-SKU snapshots require a native value array.");
    const evidence = source(snapshot);
    for (const sku of rows(data.value)) {
      if (sku.resourceType !== "virtualMachines") continue;
      const instanceType = text(sku.name);
      const caps = capabilities(sku);
      // Constrained-vCPU sizes bill differently while exposing fewer usable CPUs.
      const vcpus = positiveInteger(caps.vCPUsAvailable ?? caps.vCPUs);
      const memory = memoryMiB(caps.MemoryGB);
      const regions = Array.isArray(sku.locations) ? sku.locations.filter((r): r is string => typeof r === "string" && !!r) : [];
      if (!instanceType || !vcpus || !memory || !regions.length) { invalidShapes++; continue; }
      for (const region of regions) {
        if (snapshot.region && region !== snapshot.region) continue;
        const locationInfo = rows(sku.locationInfo).find(location => location.location === region);
        const rawZones = locationInfo?.zones;
        const zones = Array.isArray(rawZones) ? [...new Set(rawZones.filter((zone): zone is string => typeof zone === "string" && !!zone))] : [];
        const resolved = resolvePrice(prices.get(key(region, instanceType)) ?? []);
        for (const zone of zones.length ? zones : [undefined]) {
          const restricted = restrictionFor(sku, region, zone);
          const arch = architecture(caps.CpuArchitectureType);
          const mode = cpuMode(sku);
          offers.push({
            id: offerId("azure", region, instanceType, zone), provider: "azure", region, ...(zone ? { zone } : {}), instanceType,
            vcpus, memoryMiB: memory, architecture: arch, cpuMode: mode, operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
            price: resolved.price, specSource: evidence, offeringState: restricted ? "catalog_only" : "offered",
            warnings: [
              ...(resolved.warning ? [resolved.warning] : []),
              ...(restricted ? ["The imported Azure inventory reports a subscription restriction for this location; this is a catalog entry only."] : []),
              ...(arch === "unknown" ? ["CPU architecture is not established by the supplied capability metadata."] : []),
              ...(mode === "unknown" ? ["Sustained or burstable CPU behavior is not established for this resource family."] : []),
              ...(caps.vCPUsAvailable !== undefined && caps.vCPUsAvailable !== caps.vCPUs ? ["Usable vCPUs come from vCPUsAvailable; the native SKU price is retained for this constrained-vCPU size."] : []),
            ],
          });
        }
      }
    }
  }
  if (invalidShapes) warnings.push(`${invalidShapes} Azure VM SKUs lacked supported CPU, memory, type, or region fields and could not produce a comparable shape.`);
  if (unsupportedPrices) warnings.push(`${unsupportedPrices} Azure meter versions used unsupported currencies, units, tiers, or identifiers and were not treated as free.`);
  const matchedKeys = new Set(offers.map(o => key(o.region, o.instanceType)));
  const missingShapes = [...prices.keys()].filter(k => !matchedKeys.has(k)).length;
  if (missingShapes) warnings.push(`${missingShapes} Azure retail SKU records lacked ARM capability inventory; CPU or RAM were not guessed from their names.`);
  return { offers, warnings };
}
