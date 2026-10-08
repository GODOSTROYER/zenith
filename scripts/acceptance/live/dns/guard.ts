import { createHash } from "node:crypto";
import type { Packet, Permissions } from "./contracts";

export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class Guard {
  private readonly startedAt: number;
  constructor(readonly packet: Packet, readonly permissions: Permissions, private readonly now = () => Date.now()) {
    this.startedAt = now();
    this.check();
  }
  check() {
    const p = this.packet, grant = this.permissions;
    if (grant.approved !== true || grant.approvedBy !== "arnav.bule05@gmail.com" || !grant.allowTeardownReview ||
        !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= this.now() ||
        grant.packetSha256 !== digest(p) || !Number.isFinite(p.estimatedUsd) || p.estimatedUsd <= 0 ||
        !Number.isFinite(grant.maxUsd) || grant.maxUsd <= 0 || !Number.isFinite(grant.maxHours) || grant.maxHours <= 0 ||
        p.estimatedUsd > grant.maxUsd || p.durationHours > grant.maxHours || this.now() - this.startedAt >= grant.maxHours * 3600_000)
      throw new Error("Live permission, packet binding, expiry or budget refused");
  }
  url(raw: string, kind: "cloud" | "control" | "traffic") {
    this.check();
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) throw new Error("Unsafe live URL refused");
    if (kind === "control") {
      if (u.origin !== this.packet.apiOrigin || !/^\/api\/platform\/v1\//.test(u.pathname)) throw new Error("Control-plane scope refused");
      // Read-only endpoints and the one plan-scope teardown trigger; approval is never reachable.
      if (!/^\/api\/platform\/v1\/(operations\/[A-Za-z0-9_-]+(?:\/(?:events|mixed-run))?|mixed\/plans\/[A-Za-z0-9_-]+|environments\/[A-Za-z0-9_-]+\/(?:resources|teardown-review))$/.test(u.pathname))
        throw new Error("Control-plane endpoint refused");
      const env = /^\/api\/platform\/v1\/environments\/([^/]+)/.exec(u.pathname)?.[1];
      if (env && !this.packet.environmentIds.includes(env)) throw new Error("Environment outside permission refused");
    } else if (kind === "traffic") {
      if (!this.permissions.trafficOrigins.includes(u.origin)) throw new Error("Traffic endpoint outside permission refused");
    } else {
      const hosts = this.packet.provider === "azure" ? /^(management\.azure\.com|management\.usgovcloudapi\.net|management\.chinacloudapi\.cn|[a-z0-9]+\.(?:blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)|vault\.(?:azure\.net|usgovcloudapi\.net|azure\.cn)|azurecr\.(?:io|us|cn)))$/
        : this.packet.provider === "gcp" ? /^[a-z0-9-]+\.googleapis\.com$/
        : /^[a-z0-9-]+\.[a-z0-9-]+\.(?:oci\.)?oraclecloud\.com$/;
      if (!hosts.test(u.hostname) || !this.permissions.cloudOrigins.includes(u.origin)) throw new Error("Provider origin refused");
      if (this.packet.provider === "oci" && u.hostname.split(".")[1] !== this.packet.region) throw new Error("OCI region mismatch");
      const full = u.origin + u.pathname;
      if (!this.permissions.cloudPathPrefixes.some((prefix) => full === prefix || full.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")))
        throw new Error("Cloud path outside reviewed permission refused");
      // Account scoping is also enforced by the pinned packet digest and credential metadata.
      if (this.packet.provider === "azure" && u.pathname.startsWith("/subscriptions/") && u.pathname.split("/")[2].toLowerCase() !== this.packet.account.toLowerCase())
        throw new Error("Azure subscription mismatch");
      if (this.packet.provider === "gcp" && /\/projects\//.test(u.pathname) && !u.pathname.includes(`/projects/${this.packet.account}/`) && !u.pathname.includes(`/projects/${this.packet.account}:`) && !u.pathname.endsWith(`/projects/${this.packet.account}`))
        throw new Error("GCP project mismatch");
      if (this.packet.provider === "gcp" && u.searchParams.has("project") && u.searchParams.get("project") !== this.packet.account)
        throw new Error("GCP project query mismatch");
      if (this.packet.provider === "oci" && u.searchParams.has("compartmentId") && u.searchParams.get("compartmentId") !== this.packet.account)
        throw new Error("OCI compartment mismatch");
    }
    return u;
  }
  dns(name: string) {
    this.check();
    if (!this.permissions.dnsSuffixes.some((s) => name === s || name.endsWith(`.${s}`))) throw new Error("DNS name outside permission refused");
  }
}
