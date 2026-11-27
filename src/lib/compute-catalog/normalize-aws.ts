import type { ComputeArchitecture, ComputeCpuMode, ComputeOffer, RawComputeSnapshot, SourceEvidence } from "./types";
import { architecture, decimalUnits, effectiveTime, isFutureOrInvalid, object, offerId, positiveInteger, resolvePrice, rows, source, text, type PriceCandidate, type ProviderNormalization } from "./normalize-common";

interface Shape {
  region: string;
  instanceType: string;
  vcpus: number;
  memoryMiB: number;
  architecture: ComputeArchitecture;
  cpuMode: ComputeCpuMode;
  source: SourceEvidence;
}

function memoryMiB(value: unknown): number | undefined {
  const match = typeof value === "string" ? value.match(/^([\d,.]+)\s+GiB$/) : null;
  if (!match) return undefined;
  return positiveInteger(Number(match[1]!.replaceAll(",", "")) * 1024);
}

function priceArchitecture(value: unknown): ComputeArchitecture {
  if (typeof value !== "string") return "unknown";
  if (/\bGraviton\d*\b/i.test(value)) return "arm64";
  if (/\b(?:Intel|AMD)\b/i.test(value)) return "x86_64";
  return "unknown";
}

function usesRegionalPrice(locationType: string, location: string, region: string): boolean {
  if (locationType === "region") return true;
  // Local/Wavelength Zones share the EC2 regional inventory endpoint, but have
  // separate prices. Only ordinary AZ names/IDs establish a regional price join.
  // https://docs.aws.amazon.com/local-zones/latest/ug/what-is-aws-local-zones.html
  if (locationType === "availability-zone") return location.startsWith(region) && /^[a-z]$/.test(location.slice(region.length));
  return locationType === "availability-zone-id" && /^[a-z]+\d+-az\d+$/.test(location);
}

/** Joins public EC2 price products with regional DescribeInstanceTypes/Offerings exports. */
export function normalizeAwsSnapshots(snapshots: readonly RawComputeSnapshot[], asOf: string): ProviderNormalization {
  const shapes = new Map<string, Shape>();
  const prices = new Map<string, PriceCandidate[]>();
  const locations = new Map<string, Map<string, boolean>>();
  const warnings: string[] = [];
  let unsupportedShapes = 0;
  let unsupportedPrices = 0;
  const key = (region: string, instanceType: string) => `${region}:${instanceType}`;

  // Inventory is the authoritative shape source. A price list cannot prove current capacity.
  for (const snapshot of snapshots.filter(s => s.kind === "aws_instance_types")) {
    const data = object(snapshot.data);
    const evidence = source(snapshot);
    if (!snapshot.region || !Array.isArray(data.InstanceTypes)) throw new Error("AWS instance type snapshots require region and an InstanceTypes array.");
    for (const item of rows(data.InstanceTypes)) {
      const instanceType = text(item.InstanceType);
      const vcpus = positiveInteger(object(item.VCpuInfo).DefaultVCpus);
      const memory = positiveInteger(object(item.MemoryInfo).SizeInMiB);
      if (!instanceType || !vcpus || !memory) { unsupportedShapes++; continue; }
      const nativeArchitectures = object(item.ProcessorInfo).SupportedArchitectures;
      const architectures = Array.isArray(nativeArchitectures) ? [...new Set(nativeArchitectures.map(architecture).filter(a => a !== "unknown"))] : [];
      const shape: Shape = {
        region: snapshot.region, instanceType, vcpus, memoryMiB: memory,
        architecture: architectures.length === 1 ? architectures[0]! : "unknown",
        cpuMode: item.BurstablePerformanceSupported === true ? "burstable" : item.BurstablePerformanceSupported === false ? "sustained" : "unknown",
        source: evidence,
      };
      const previous = shapes.get(key(snapshot.region, instanceType));
      if (previous && JSON.stringify([previous.vcpus, previous.memoryMiB, previous.architecture, previous.cpuMode]) !== JSON.stringify([shape.vcpus, shape.memoryMiB, shape.architecture, shape.cpuMode])) {
        throw new Error(`Conflicting AWS hardware snapshots for ${snapshot.region}/${instanceType}.`);
      }
      if (!previous || Date.parse(shape.source.retrievedAt) > Date.parse(previous.source.retrievedAt)) shapes.set(key(snapshot.region, instanceType), shape);
    }
  }

  for (const snapshot of snapshots.filter(s => s.kind === "aws_instance_offerings")) {
    const data = object(snapshot.data);
    if (!Array.isArray(data.InstanceTypeOfferings)) throw new Error("AWS offering snapshots require an InstanceTypeOfferings array.");
    for (const item of rows(data.InstanceTypeOfferings)) {
      const instanceType = text(item.InstanceType);
      const location = text(item.Location);
      const type = text(item.LocationType);
      const region = type === "region" ? location : snapshot.region;
      if (!instanceType || !location || !region || !["region", "availability-zone", "availability-zone-id"].includes(type ?? "")) {
        warnings.push("An AWS offering with an unsupported or missing location was not used to establish availability.");
        continue;
      }
      if (snapshot.region && region !== snapshot.region) throw new Error("AWS offering region does not match its snapshot scope.");
      const existing = locations.get(key(region, instanceType)) ?? new Map<string, boolean>();
      const zone = type === "region" ? "" : location;
      const regionalPrice = usesRegionalPrice(type!, location, region);
      existing.set(zone, (existing.get(zone) ?? true) && regionalPrice);
      locations.set(key(region, instanceType), existing);
    }
  }

  for (const snapshot of snapshots.filter(s => s.kind === "aws_ec2_prices")) {
    const data = object(snapshot.data);
    const evidence = source(snapshot);
    const nativeOnDemand = object(data.terms).OnDemand;
    if (!data.products || typeof data.products !== "object" || Array.isArray(data.products) || !nativeOnDemand || typeof nativeOnDemand !== "object" || Array.isArray(nativeOnDemand)) {
      throw new Error("AWS price snapshots require the native products and terms.OnDemand objects.");
    }
    const onDemand = object(object(data.terms).OnDemand);
    for (const [productKey, value] of Object.entries(object(data.products))) {
      const product = object(value);
      const attrs = object(product.attributes);
      if (product.productFamily !== "Compute Instance" || attrs.operatingSystem !== "Linux" || attrs.tenancy !== "Shared" || attrs.preInstalledSw !== "NA" || attrs.capacitystatus !== "Used") continue;
      const instanceType = text(attrs.instanceType);
      const region = text(attrs.regionCode) ?? snapshot.region;
      if (!instanceType || !region) { unsupportedShapes++; continue; }
      if (snapshot.region && region !== snapshot.region) throw new Error("AWS price region does not match its snapshot scope.");
      const shapeKey = key(region, instanceType);
      const previousShape = shapes.get(shapeKey);
      const priceVcpus = positiveInteger(attrs.vcpu);
      const priceMemory = memoryMiB(attrs.memory);
      if (previousShape && ((priceVcpus && priceVcpus !== previousShape.vcpus) || (priceMemory && priceMemory !== previousShape.memoryMiB))) {
        throw new Error(`AWS price and hardware records disagree for ${region}/${instanceType}.`);
      }
      if (!shapes.has(shapeKey)) {
        const vcpus = priceVcpus;
        const memory = priceMemory;
        if (!vcpus || !memory) { unsupportedShapes++; continue; }
        shapes.set(shapeKey, { region, instanceType, vcpus, memoryMiB: memory, architecture: priceArchitecture(attrs.physicalProcessor), cpuMode: "unknown", source: evidence });
      }
      // Linux/UNIX uses RunInstances; suffixed operations can carry another platform/license.
      // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/billing-info-fields.html
      if (attrs.operation !== "RunInstances") { unsupportedPrices++; continue; }
      const candidates = prices.get(shapeKey) ?? [];
      const sku = text(product.sku) ?? productKey;
      for (const termValue of Object.values(object(onDemand[sku]))) {
        const term = object(termValue);
        if (isFutureOrInvalid(term.effectiveDate, asOf)) continue;
        const dimensions = Object.values(object(term.priceDimensions)).map(object);
        // Flat instance-hour meters only; do not silently collapse tiers or other units.
        const dimension = dimensions[0] ?? {};
        const amount = decimalUnits(object(dimension.pricePerUnit).USD);
        const supported = dimensions.length === 1 && dimension.unit === "Hrs" && String(dimension.beginRange) === "0" && dimension.endRange === "Inf" && amount !== undefined;
        if (!supported) unsupportedPrices++;
        const effectiveAt = effectiveTime(term.effectiveDate, asOf);
        candidates.push({ amount: supported ? amount! : null, source: evidence, nativeSku: sku, ...(effectiveAt ? { effectiveAt } : {}) });
      }
      prices.set(shapeKey, candidates);
    }
  }

  const offers: ComputeOffer[] = [];
  for (const [shapeKey, shape] of shapes) {
    const locationSet = locations.get(shapeKey);
    // Prefer the most specific inventory evidence if both regional and zonal exports were supplied.
    const zones = locationSet?.size ? [...locationSet.keys()].filter(zone => zone || locationSet.size === 1) : [""];
    const resolved = resolvePrice(prices.get(shapeKey) ?? []);
    for (const zone of zones) {
      const regionalPrice = !locationSet || locationSet.get(zone) === true;
      const offerWarnings = [
        ...(resolved.warning ? [resolved.warning] : []),
        ...(!regionalPrice ? ["The supplied zonal location is not established as an ordinary Availability Zone; parent-region prices were not applied."] : []),
        ...(!locationSet ? ["Regional offering inventory was not supplied; a catalog entry does not prove availability."] : []),
        ...(shape.architecture === "unknown" ? ["CPU architecture is not established by the supplied metadata."] : []),
        ...(shape.cpuMode === "unknown" ? ["Sustained or burstable CPU behavior is not established by the supplied metadata."] : []),
      ];
      offers.push({
        id: offerId("aws", shape.region, shape.instanceType, zone || undefined), provider: "aws", region: shape.region,
        ...(zone ? { zone } : {}), instanceType: shape.instanceType, vcpus: shape.vcpus, memoryMiB: shape.memoryMiB,
        architecture: shape.architecture, cpuMode: shape.cpuMode, operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
        price: regionalPrice ? resolved.price : null, specSource: shape.source, offeringState: locationSet ? "offered" : "catalog_only", warnings: offerWarnings,
      });
    }
  }
  if (unsupportedShapes) warnings.push(`${unsupportedShapes} AWS records lacked supported CPU, memory, type, or region fields and could not produce a comparable shape.`);
  if (unsupportedPrices) warnings.push(`${unsupportedPrices} AWS price records used unsupported operations, units, tiers, or amounts and were not treated as free.`);
  const missingShapeCount = [...locations.keys()].filter(k => !shapes.has(k)).length;
  if (missingShapeCount) warnings.push(`${missingShapeCount} AWS offerings had no hardware metadata in the supplied snapshots.`);
  return { offers, warnings: [...new Set(warnings)] };
}
