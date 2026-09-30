/**
 * Cost engine v2 (ADR-0013): prices a placed resource graph from the versioned
 * catalog, including the line items the V1 table never modeled: NAT gateways,
 * public IPv4, load balancer hours and capacity, egress, requests, provisioned
 * IOPS, backups, log ingestion, DNS and cross-region / cross-cloud transfer.
 *
 * Pure: no network, no clock, no environment. `computedAt` is `options.now` or
 * the catalog snapshot time, never `Date.now()`, so equal inputs give equal
 * output (the solver relies on this).
 *
 * Output is an ESTIMATE of monthly USD list price. It is never an invoice,
 * and `included` / `excluded` say what it does and does not cover. Each line
 * carries a `basis` string with the arithmetic and `priceVerification` saying
 * how the unit price was obtained; `assumptions.priceEvidenceWeakUsd` totals
 * the part of the estimate resting on remembered, derived or internal prices.
 *
 * Spec keys read from `ResourceNode.spec` (unknown keys are ignored, defaults
 * are applied and recorded in `assumptions`; a value of the wrong type or an
 * unknown size throws `CostInputError` rather than guessing):
 *   container_service / scheduled_job: size, replicas (default 1), publicIp
 *   compute_instance: size, count|replicas, volumeGb (20), iops, publicIp,
 *     backupRetentionDays (snapshots only when set)
 *   postgres / mysql: size, highAvailability|ha|multiAz, storageGb, iops, backupRetentionDays, backup (false | "none" | "daily" | "hourly")
 *   redis: size, ha, replicas (nodes)
 *   object_store: storageGb, requestsMillions
 *   queue / pubsub: requestsMillions
 *   volume: sizeGb|storageGb, iops
 *   dns_zone: queriesMillions
 *   network: natGateways | egress.natGateways ("none" | "single" default | "per_az"), azCount | zones (count) | zones[]
 * Only `ownership: "managed"` nodes are billed (referenced and external
 * resources are not Zenith's bill), matching the legacy model.
 *
 * Sizes: see `sizes.ts` (same nano/small/standard/performance vCPU and memory
 * as legacy SIZE_SPECS, memory raised to the 2 GB per vCPU provider minimum).
 *
 * Modeling rules worth knowing (all also stated in `basis` / `assumptions`):
 * - 730 billable hours per month.
 * - NAT: needed when a compute node has no public IP. One gateway per private
 *   network by default; `per_az` bills one per availability zone. All internet
 *   egress of private workloads is assumed to pass through NAT.
 * - Public IPv4: load balancers (one per AZ on AWS, one elsewhere), NAT
 *   gateway addresses and public workloads.
 * - Egress: `usage.egressGb` at the FIRST-tier internet price for every GB;
 *   free tiers are not deducted and volume discounts are not applied.
 *   Split evenly across sites that host a load balancer (or, with none, compute).
 * - Cross-boundary traffic: each data-plane edge whose ends differ in provider
 *   or region moves `egressGb x interComponentFraction` GB, billed on the
 *   sender side (callee for request/response edges, caller for publishes) at
 *   the inter-region price (same provider) or the internet price (cross-cloud).
 * - Backups: `storageGb x (1 + 0.05 x retentionDays)`; provider free backup
 *   allowances are not deducted.
 */
import type { CostDiff, CostEstimate, CostLine, UsageAssumptions } from "@/lib/placement/types";
import { catalogSnapshotAt, MissingPriceError } from "@/lib/placement/pricebook";
import { skuFor, type SkuRole } from "@/lib/placement/capabilities";
import {
  BACKUP_CHANGE_RATE_PER_DAY,
  CostInputError,
  DEFAULT_AZ_COUNT,
  DEFAULT_BACKUP_RETENTION_DAYS,
  HOURS_PER_MONTH,
  LCU_NEW_CONNECTIONS_PER_SECOND,
  Ledger,
  OBJECT_READ_SHARE,
  TRAFFIC_RELATIONS,
  azCountOf,
  fmt,
  isPublic,
  priceCache,
  priceContainer,
  priceDatabase,
  priceDnsZone,
  priceObjectStore,
  priceQueue,
  priceVm,
  priceVolume,
  q6,
  replicasOf,
  resolveUsage,
  round2,
  specOf,
  toPriceBook,
  type CostEdge,
  type CostGraph,
  type CostNode,
  type CostOptions,
} from "@/lib/placement/cost-model";

export {
  BACKUP_CHANGE_RATE_PER_DAY,
  CostInputError,
  DEFAULT_AZ_COUNT,
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_USAGE,
  HOURS_PER_MONTH,
  LCU_NEW_CONNECTIONS_PER_SECOND,
  OBJECT_READ_SHARE,
  SCHEDULED_JOB_DUTY,
  resolveUsage,
  round2,
  toPriceBook,
  type CostEdge,
  type CostGraph,
  type CostNode,
  type CostOptions,
} from "@/lib/placement/cost-model";

/** Kinds that are free or bundled and produce no line. */
const FREE_KINDS = new Set<string>(["network", "subnet", "firewall", "identity", "dns_record", "log_group"]);
/** Kinds the catalog does not price; named in `excluded`. */
const UNPRICED_KINDS: Record<string, string> = {
  function: "serverless functions",
  static_site: "static site hosting and CDN",
  container_registry: "container registry storage and pulls",
  secret: "secret manager per-secret and API charges",
  kubernetes_cluster: "Kubernetes control-plane fees and node pools",
  kubernetes_namespace: "Kubernetes namespaces (priced with their cluster)",
  build_pipeline: "build pipeline minutes",
  provider_native: "provider-native (Level 3) resources",
};

/* ------------------------------ cross-boundary ----------------------------- */

export interface PlannedTransfer {
  sender: CostNode;
  receiver: CostNode;
  relation: string;
  sameProvider: boolean;
  role: SkuRole;
  gb: number;
}

/**
 * Data-plane edges whose ends differ in provider or region, with the GB they
 * are assumed to move. Billed on the sender: the callee for request/response
 * edges (responses dominate), the caller for `publishes_to`.
 */
function planTransfers(
  nodes: readonly CostNode[],
  edges: readonly CostEdge[],
  usage: Required<UsageAssumptions>,
  knownProviders: ReadonlySet<string>,
): { items: PlannedTransfer[]; excluded: string[]; unpricedProviders: string[] } {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const seen = new Set<string>();
  const items: PlannedTransfer[] = [];
  const excluded = new Set<string>();
  const unpriced = new Set<string>();
  const sorted = [...edges].sort((a, b) => {
    const ka = `${a.from}\u0000${a.to}\u0000${a.relation}`;
    const kb = `${b.from}\u0000${b.to}\u0000${b.relation}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const e of sorted) {
    if (!TRAFFIC_RELATIONS.has(e.relation)) continue;
    const a = byAddress.get(e.from);
    const b = byAddress.get(e.to);
    if (!a || !b) continue;
    if (a.provider === b.provider && a.region === b.region) continue;
    const sender = e.relation === "publishes_to" ? a : b;
    const receiver = sender === a ? b : a;
    if ((sender.ownership ?? "managed") !== "managed") {
      excluded.add("Traffic sent by referenced or external resources is charged to their owner and is not counted.");
      continue;
    }
    if (!knownProviders.has(sender.provider)) {
      unpriced.add(sender.provider);
      continue;
    }
    const key = `${sender.address}>${receiver.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sameProvider = sender.provider === receiver.provider;
    items.push({
      sender,
      receiver,
      relation: e.relation,
      sameProvider,
      role: sameProvider ? "egress_inter_region_gb" : "egress_internet_gb",
      gb: usage.egressGb * usage.interComponentFraction,
    });
  }
  return { items, excluded: [...excluded], unpricedProviders: [...unpriced] };
}

export interface TransferCost {
  from: string;
  to: string;
  kind: "cross_region" | "cross_cloud";
  gb: number;
  usd: number;
}

/** Monthly cost of each cross-region / cross-cloud data-plane edge, as `estimateGraphCost` prices them. */
export function listCrossBoundaryTransfers(graph: CostGraph, options: CostOptions): TransferCost[] {
  const book = toPriceBook(options.catalog);
  const usage = resolveUsage(options.usage);
  const known = new Set(book.providers());
  const t = planTransfers(graph.nodes, graph.edges ?? [], usage, known);
  return t.items.map((x) => {
    const sku = skuFor(x.sender.provider, x.role);
    const e = sku ? book.find(x.sender.provider, x.sender.region, sku) : undefined;
    if (!e) throw new MissingPriceError(x.sender.provider, x.sender.region, sku ?? x.role);
    return { from: x.sender.address, to: x.receiver.address, kind: x.sameProvider ? "cross_region" : "cross_cloud", gb: x.gb, usd: x.gb * e.usd };
  });
}

/* --------------------------------- estimate -------------------------------- */

interface Site {
  key: string;
  provider: string;
  region: string;
  nodes: CostNode[];
}

function isCompute(n: CostNode): boolean {
  return n.kind === "container_service" || n.kind === "compute_instance" || n.kind === "scheduled_job";
}

export function estimateGraphCost(graph: CostGraph, options: CostOptions): CostEstimate {
  const book = toPriceBook(options.catalog);
  const usage = resolveUsage(options.usage);
  const policyRetention = options.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
  if (!Number.isInteger(policyRetention) || policyRetention < 0) throw new CostInputError("backupRetentionDays must be an integer >= 0.");
  const l = new Ledger(book);

  const seen = new Set<string>();
  const nodes = [...graph.nodes].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.kind < b.kind ? -1 : 1));
  for (const n of nodes) {
    if (seen.has(n.address)) throw new CostInputError(`Duplicate node address ${n.address}.`);
    seen.add(n.address);
  }

  const known = new Set(book.providers());
  const priced = nodes.filter((n) => (n.ownership ?? "managed") === "managed");
  const skippedNotOurs = nodes.length - priced.length;
  const sites = new Map<string, Site>();
  const unpricedKinds = new Map<string, number>();

  for (const n of priced) {
    if (!known.has(n.provider)) {
      l.unpricedProviders.add(n.provider);
      continue;
    }
    if (!book.regions(n.provider).includes(n.region)) throw new MissingPriceError(n.provider, n.region, "(region not in catalog)");
    const key = `${n.provider}|${n.region}`;
    const site = sites.get(key) ?? { key, provider: n.provider, region: n.region, nodes: [] };
    site.nodes.push(n);
    sites.set(key, site);
  }

  // Per-node lines.
  for (const site of [...sites.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    for (const n of site.nodes) {
      switch (n.kind) {
        case "container_service":
        case "scheduled_job":
          priceContainer(l, n);
          break;
        case "compute_instance":
          priceVm(l, n);
          break;
        case "postgres":
        case "mysql":
          priceDatabase(l, n, usage, policyRetention);
          break;
        case "redis":
          priceCache(l, n);
          break;
        case "object_store":
          priceObjectStore(l, n, usage);
          break;
        case "queue":
        case "pubsub":
          priceQueue(l, n);
          break;
        case "volume":
          priceVolume(l, n);
          break;
        case "dns_zone":
          priceDnsZone(l, n);
          break;
        case "tls_certificate":
          l.charge({ address: n.address, description: "Public TLS certificate", provider: n.provider, region: n.region, role: "cert_month", quantity: 1, basis: "1 certificate" });
          break;
        case "load_balancer":
          break; // priced at site level below
        default:
          if (!FREE_KINDS.has(n.kind)) unpricedKinds.set(n.kind, (unpricedKinds.get(n.kind) ?? 0) + 1);
      }
    }
  }

  // Site-level shared lines: entry traffic, LB, NAT, IPv4, egress, logs.
  const siteList = [...sites.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const withLb = siteList.filter((s) => s.nodes.some((n) => n.kind === "load_balancer"));
  const withCompute = siteList.filter((s) => s.nodes.some((n) => isCompute(n) && replicasOf(n) > 0));
  const entrySites = withLb.length > 0 ? withLb : withCompute;
  const entryShare = entrySites.length > 0 ? 1 / entrySites.length : 0;
  let maxAz = 0;

  for (const site of siteList) {
    const { provider, region } = site;
    const isEntry = entrySites.includes(site);
    const egressGbSite = isEntry ? usage.egressGb * entryShare : 0;
    const requestsSite = isEntry ? usage.requestsMillions * entryShare : 0;
    const networks = site.nodes.filter((n) => n.kind === "network");
    const lbs = site.nodes.filter((n) => n.kind === "load_balancer");
    const compute = site.nodes.filter((n) => isCompute(n) && replicasOf(n) > 0);
    const azSite = networks.length > 0 ? Math.max(...networks.map(azCountOf)) : DEFAULT_AZ_COUNT;
    maxAz = Math.max(maxAz, azSite);

    // Load balancers.
    const rps = (requestsSite * 1e6) / (HOURS_PER_MONTH * 3600);
    for (const lb of lbs) {
      l.charge({
        address: lb.address,
        description: "Load balancer hours",
        provider,
        region,
        role: "lb_hour",
        quantity: HOURS_PER_MONTH,
        basis: `${HOURS_PER_MONTH} h × 1 load balancer`,
      });
      const perLbRps = rps / lbs.length;
      if (skuFor(provider, "lb_capacity_unit_hour")) {
        const lcu = Math.max(1, perLbRps / LCU_NEW_CONNECTIONS_PER_SECOND);
        l.charge({
          address: lb.address,
          description: "Load balancer capacity units",
          provider,
          region,
          role: "lb_capacity_unit_hour",
          quantity: HOURS_PER_MONTH * lcu,
          basis: `${HOURS_PER_MONTH} h × ${fmt(lcu)} capacity unit(s) = max(1, ${fmt(perLbRps)} req/s ÷ ${LCU_NEW_CONNECTIONS_PER_SECOND} new connections/s); upper bound that treats every request as a new connection`,
        });
      } else if (skuFor(provider, "lb_processed_gb")) {
        const gb = egressGbSite / lbs.length;
        l.charge({
          address: lb.address,
          description: "Load balancer data processed",
          provider,
          region,
          role: "lb_processed_gb",
          quantity: gb,
          basis: `${fmt(gb)} GB assumed processed (equal to internet egress share)`,
        });
      }
    }

    // NAT gateways.
    const privateCompute = compute.filter((n) => !isPublic(n));
    const publicCompute = compute.filter(isPublic);
    let natTotal = 0;
    if (privateCompute.length > 0) {
      const nets: (CostNode | undefined)[] = networks.length > 0 ? networks : [undefined];
      const totalReplicas = compute.reduce((s, n) => s + replicasOf(n), 0);
      const privateReplicas = privateCompute.reduce((s, n) => s + replicasOf(n), 0);
      const privateFraction = totalReplicas > 0 ? privateReplicas / totalReplicas : 0;
      for (const net of nets) {
        const netSpec = net ? specOf(net) : undefined;
        // top-level `natGateways`, or the resource model's `egress.natGateways` (NetworkSpec)
        const egress = netSpec?.egress as { natGateways?: unknown } | undefined;
        const rawMode = netSpec ? (netSpec.natGateways ?? egress?.natGateways) : undefined;
        const mode = rawMode === undefined ? "single" : rawMode;
        if (mode !== "none" && mode !== "single" && mode !== "per_az") {
          throw new CostInputError(`${net?.address ?? "network"}: spec.natGateways must be "none", "single" or "per_az".`);
        }
        const az = net ? azCountOf(net) : DEFAULT_AZ_COUNT;
        const count = mode === "none" ? 0 : mode === "single" ? 1 : az;
        natTotal += count;
        if (count === 0) continue;
        l.charge({
          address: net?.address,
          description: "NAT gateway hours",
          provider,
          region,
          role: "nat_hour",
          quantity: HOURS_PER_MONTH * count,
          basis: `${HOURS_PER_MONTH} h × ${count} NAT gateway(s) (${mode === "per_az" ? `one per AZ, ${az} AZ` : "one per private network"})`,
        });
        const gb = (egressGbSite * privateFraction) / nets.length;
        l.charge({
          address: net?.address,
          description: "NAT gateway data processed",
          provider,
          region,
          role: "nat_gb",
          quantity: gb,
          basis: `${fmt(gb)} GB = ${fmt(egressGbSite)} GB site egress × ${fmt(privateFraction)} share from private workloads`,
        });
      }
    }

    // Public IPv4.
    const lbIps = lbs.length * (provider === "aws" ? azSite : 1);
    const workloadIps = publicCompute.reduce((s, n) => s + replicasOf(n), 0);
    const ips = lbIps + natTotal + workloadIps;
    if (ips > 0) {
      l.charge({
        provider,
        region,
        description: "Public IPv4 addresses",
        role: "ipv4_hour",
        quantity: HOURS_PER_MONTH * ips,
        basis: `${HOURS_PER_MONTH} h × ${ips} address(es) = ${lbIps} load balancer (${lbs.length} LB${provider === "aws" ? ` × ${azSite} AZ` : ""}) + ${natTotal} NAT + ${workloadIps} public workload`,
        who: `site ${site.key}`,
      });
    }

    // Internet egress.
    if (isEntry && egressGbSite > 0) {
      l.charge({
        provider,
        region,
        description: "Internet egress",
        role: "egress_internet_gb",
        quantity: egressGbSite,
        basis: `${fmt(usage.egressGb)} GB egress${entrySites.length > 1 ? ` ÷ ${entrySites.length} serving sites` : ""} at the first-tier price; free tiers and volume discounts not applied`,
        who: `site ${site.key}`,
      });
    }

    // Logs.
    for (const n of compute) {
      l.charge({
        address: n.address,
        description: "Log ingestion",
        provider,
        region,
        role: "logs_ingest_gb",
        quantity: usage.logGbPerService,
        basis: `${fmt(usage.logGbPerService)} GB per service per month`,
      });
    }
  }

  // Cross-boundary traffic on data-plane edges.
  let crossGb = 0;
  const transfers = planTransfers(nodes, graph.edges ?? [], usage, known);
  for (const t of transfers.items) {
    crossGb += t.gb;
    l.charge({
      address: t.sender.address,
      description: `${t.sameProvider ? "Cross-region" : "Cross-cloud"} transfer ${t.sender.address} -> ${t.receiver.address}`,
      provider: t.sender.provider,
      region: t.sender.region,
      role: t.role,
      quantity: t.gb,
      basis: `${fmt(usage.interComponentFraction * 100)}% of ${fmt(usage.egressGb)} GB egress assumed to flow ${t.sender.provider}/${t.sender.region} -> ${t.receiver.provider}/${t.receiver.region}; billed at the sender's ${t.sameProvider ? "inter-region" : "internet egress (cross-cloud)"} price`,
    });
  }
  for (const x of transfers.excluded) l.excluded.add(x);
  for (const p of transfers.unpricedProviders) l.unpricedProviders.add(p);

  // Assemble.
  const ledger = l.lines.sort((x, y) => {
    const ka = `${x.line.address ?? ""}\u0000${x.line.sku}\u0000${x.line.description}`;
    const kb = `${y.line.address ?? ""}\u0000${y.line.sku}\u0000${y.line.description}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const rawTotal = ledger.reduce((s, x) => s + x.raw, 0);
  const weakUsd = ledger.filter((x) => x.weak).reduce((s, x) => s + x.raw, 0);
  const lines = ledger.map((x) => x.line);

  const assumptions: Record<string, number | string> = {
    hoursPerMonth: HOURS_PER_MONTH,
    egressGb: usage.egressGb,
    requestsMillions: usage.requestsMillions,
    storageGb: usage.storageGb,
    dbStorageGb: usage.dbStorageGb,
    logGbPerService: usage.logGbPerService,
    interComponentFraction: usage.interComponentFraction,
    azCountDefault: DEFAULT_AZ_COUNT,
    natGatewaysDefault: "single",
    backupRetentionDays: policyRetention,
    backupChangeRatePerDay: BACKUP_CHANGE_RATE_PER_DAY,
    objectStoreReadShare: OBJECT_READ_SHARE,
    priceEvidenceWeakLines: ledger.filter((x) => x.weak).length,
    priceEvidenceWeakUsd: round2(weakUsd),
    ...l.assumed,
  };
  if (maxAz > 0) assumptions.azCountMax = maxAz;
  if (crossGb > 0) assumptions.crossBoundaryGb = q6(crossGb);

  const has = (pred: (x: CostLine) => boolean) => lines.some(pred);
  const included: string[] = ["Compute, database, cache, storage and queue charges at on-demand list prices"];
  if (has((x) => x.description.startsWith("NAT gateway"))) included.push("NAT gateway hours and data processing");
  if (has((x) => x.description === "Public IPv4 addresses")) included.push("Public IPv4 addresses (load balancers, NAT gateways, public workloads)");
  if (has((x) => x.description.startsWith("Load balancer"))) included.push("Load balancer hours and capacity / processed-data charges");
  if (has((x) => x.description === "Internet egress")) included.push("Internet egress");
  if (has((x) => x.description.startsWith("Cross-"))) included.push("Cross-region and cross-cloud transfer between components");
  if (has((x) => x.description.includes("requests") || x.description.includes("queries"))) included.push("Object storage, queue and DNS request charges");
  if (has((x) => x.description.includes("IOPS"))) included.push("Provisioned IOPS");
  if (has((x) => x.description.includes("backup") || x.description.includes("snapshots"))) included.push("Backup and snapshot storage");
  if (has((x) => x.description === "Log ingestion")) included.push("Log ingestion");
  if (has((x) => x.description.includes("high availability"))) included.push("High-availability standby capacity");

  const excluded: string[] = [
    "Taxes (VAT/GST), currency conversion and payment fees",
    "Discounts: savings plans, committed use, reserved instances, spot, enterprise agreements and credits",
    "Provider free tiers and free monthly allowances are not deducted (conservative), except where the list price itself is zero",
    "Volume-tier egress discounts: the first-tier per-GB price is applied to every GB",
    "Data transfer between availability zones inside one region",
    "Container registry storage and image pulls, and CI/CD build minutes",
    "Monitoring metrics, alarms, traces and dashboards (only log ingestion is modeled)",
    "Secret manager and key management charges",
    "WAF, DDoS protection, CDN and API gateway charges",
    "Support plans and marketplace fees",
    "This is an estimate from a static list-price catalog, not an invoice or a quote",
  ];
  for (const [kind, count] of [...unpricedKinds.entries()].sort()) {
    excluded.push(`${count} ${kind} node(s): ${UNPRICED_KINDS[kind] ?? kind} not priced by catalog ${book.catalog.version}`);
  }
  for (const p of [...l.unpricedProviders].sort()) excluded.push(`Resources on provider "${p}" have no price catalog and are not priced`);
  if (skippedNotOurs > 0) excluded.push(`${skippedNotOurs} referenced or external node(s) are not Zenith's bill and are not priced`);
  for (const x of [...l.excluded].sort()) excluded.push(x);
  if (nodes.some((n) => n.kind === "mysql")) excluded.push("MySQL is priced with the provider's PostgreSQL SKUs (approximation)");

  return {
    kind: "estimate",
    catalogVersion: book.catalog.version,
    currency: "USD",
    monthlyUsd: round2(rawTotal),
    lines,
    assumptions,
    included,
    excluded: [...new Set(excluded)],
    computedAt: options.now ?? catalogSnapshotAt(book.catalog),
  };
}

/* ---------------------------------- diff ---------------------------------- */

/** Line-level monthly delta between two estimates (added, removed and changed lines only). */
export function diffCost(before: CostEstimate, after: CostEstimate): CostDiff {
  const key = (x: CostLine) => `${x.address ?? ""}\u0000${x.sku}\u0000${x.description}`;
  const collect = (e: CostEstimate) => {
    const m = new Map<string, { line: CostLine; usd: number }>();
    for (const x of e.lines) {
      const k = key(x);
      const cur = m.get(k);
      m.set(k, { line: x, usd: (cur?.usd ?? 0) + x.monthlyUsd });
    }
    return m;
  };
  const b = collect(before);
  const a = collect(after);
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort();
  const lines: CostDiff["lines"] = [];
  for (const k of keys) {
    const bb = b.get(k);
    const aa = a.get(k);
    const beforeUsd = round2(bb?.usd ?? 0);
    const afterUsd = round2(aa?.usd ?? 0);
    const delta = round2(afterUsd - beforeUsd);
    if (bb && aa && delta === 0) continue;
    const ref = (aa ?? bb)!.line;
    lines.push({
      ...(ref.address !== undefined ? { address: ref.address } : {}),
      sku: ref.sku,
      description: ref.description,
      beforeUsd,
      afterUsd,
      deltaUsd: delta,
      change: !bb ? "added" : !aa ? "removed" : "changed",
    });
  }
  return {
    beforeMonthlyUsd: before.monthlyUsd,
    afterMonthlyUsd: after.monthlyUsd,
    deltaMonthlyUsd: round2(after.monthlyUsd - before.monthlyUsd),
    lines,
    catalogChanged: before.catalogVersion !== after.catalogVersion,
  };
}
