/**
 * PROD-LIFE-09 build isolation profiles, the AWS egress/metadata guard and the
 * provider attestations. Pure: no cloud, no database.
 */
import type { Build } from "@aws-sdk/client-codebuild";
import { describe, expect, it } from "vitest";
import { BUILD_ISOLATION_PROFILES, BuildIsolationError, assertBuildIsolation, boundedTimeoutSec, contextDirOf, normalizeContextDir, profileFor, type ObservedBuildIsolation } from "@/lib/execution/build-isolation";
import { DEFAULT_BUILD_EGRESS_HOSTS, contextDirFromBuildspec, egressGuardCommands, egressHosts, hostsFromBuildspec } from "@/lib/providers/aws/drivers/compute/codebuild-isolation";
import { awsBuildAttestation } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import { dockerBuildspec } from "@/lib/providers/aws/drivers/compute/codebuild-project";
import { validateBuildInput } from "@/lib/providers/gcp/drivers/build/build-api";
import { awsIsolation } from "./fakes/provenance";

const closed = { allowOpenEgress: false };
const open = { allowOpenEgress: true };
const violations = (o: ObservedBuildIsolation, policy = closed): string[] => {
  try {
    assertBuildIsolation("aws", o, policy);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(BuildIsolationError);
    return [...(e as BuildIsolationError).violations];
  }
};

describe("build isolation profiles", () => {
  it("defines one profile per provider with bounded resources and a documented mechanism for every control", () => {
    for (const provider of ["aws", "gcp", "azure"] as const) {
      const p = profileFor(provider);
      expect(p.provider).toBe(provider);
      expect(p.limits.maxTimeoutSec).toBeLessThanOrEqual(1800);
      expect(p.limits.computeClasses.length).toBeGreaterThan(0);
      for (const text of Object.values(p.mechanisms)) expect(text.length).toBeGreaterThan(20);
    }
    expect(BUILD_ISOLATION_PROFILES.aws.mechanisms.identity).toMatch(/never the deploy role/);
  });

  it("refuses a provider with no profile (OCI and Kubernetes source builds stay refused)", () => {
    expect(() => profileFor("oci")).toThrow(BuildIsolationError);
    expect(() => assertBuildIsolation("kubernetes", awsIsolation(), closed)).toThrow(/no build isolation profile/);
  });

  it("accepts a compliant AWS observation and records no exception", () => {
    expect(assertBuildIsolation("aws", awsIsolation(), closed)).toEqual({ exceptions: [] });
  });

  it.each([
    ["a role that is not a build role (for example the deploy role)", { identity: { principal: "arn:aws:iam::123456789012:role/zenith-deploy", dedicated: true, deployCredentials: "absent" as const } }, /not a build role/],
    ["an identity that is not dedicated", { identity: { principal: "arn:aws:iam::123456789012:role/zenith-api-build", dedicated: false, deployCredentials: "absent" as const } }, /dedicated build identity/],
    ["deployment credentials that were not shown absent", { identity: { principal: "arn:aws:iam::123456789012:role/zenith-api-build", dedicated: true, deployCredentials: "unknown" as const } }, /deployment credentials/],
    ["unknown metadata exposure", { metadata: { exposes: "unknown" as const, mechanism: "x" } }, /metadata/],
    ["a writable source mount", { filesystem: { sourceMount: "read_write" as const } }, /read-only/],
    ["a timeout above the bound", { resources: { timeoutSec: 7200, computeClass: "BUILD_GENERAL1_MEDIUM" } }, /timeout/],
    ["a compute class outside the profile", { resources: { timeoutSec: 600, computeClass: "BUILD_GENERAL1_2XLARGE" } }, /compute class/],
    ["direct dependency downloads", { dependencies: { downloads: "direct" as const } }, /dependency downloads/],
    ["an allowlist that is not bound to a verification", { network: { egress: "allowlisted" as const, mechanism: "x" } }, /not bound to a verification/],
  ])("refuses %s", (_name, override, message) => {
    const found = violations(awsIsolation(override));
    expect(found.join(" | ")).toMatch(message);
  });

  it("refuses unrestricted egress unless the operator exception is set, and then records it", () => {
    const unrestricted = awsIsolation({ network: { egress: "unrestricted", mechanism: "none" }, dependencies: { downloads: "direct" } });
    expect(violations(unrestricted).join(" ")).toMatch(/egress was not restricted/);
    expect(assertBuildIsolation("aws", unrestricted, open)).toEqual({ exceptions: ["open_egress"] });
  });

  it("bounds a requested timeout by the profile", () => {
    expect(boundedTimeoutSec("aws", undefined)).toBe(1800);
    expect(boundedTimeoutSec("gcp", 600)).toBe(600);
    expect(() => boundedTimeoutSec("gcp", 3600)).toThrow(BuildIsolationError);
    expect(() => boundedTimeoutSec("azure", 5)).toThrow(BuildIsolationError);
  });
});

describe("build context directory and builder admission", () => {
  it.each([[undefined, "."], ["", "."], [".", "."], ["services/api", "services/api"], ["apps/web-1/src_v2", "apps/web-1/src_v2"]])("accepts %j as %j", (raw, expected) => {
    expect(normalizeContextDir(raw)).toBe(expected);
  });
  it.each(["/abs", "../up", "a/../b", "a//b", "a/./b", "a/", "a\b", "a b", "$(id)", "x".repeat(201), 7])("refuses %j", (raw) => {
    expect(() => normalizeContextDir(raw)).toThrow(BuildIsolationError);
  });
  it("refuses buildpack builders explicitly and honors a subdirectory on every provider", () => {
    expect(() => contextDirOf({ source: { builder: "buildpacks" } }, "aws")).toThrow(/no isolated builder/);
    expect(contextDirOf({ source: { contextDir: "apps/web" } }, "azure")).toBe("apps/web");
    expect(contextDirOf({ source: { contextDir: "apps/web", builder: "dockerfile" } }, "gcp")).toBe("apps/web");
    expect(contextDirOf({ source: {} }, "azure")).toBe(".");
  });
  it("puts the context directory in the AWS buildspec and recovers it from an executed one", () => {
    const spec = dockerBuildspec(undefined, "apps/web");
    expect(spec).toContain("\"$ZENITH_REPO_URL:src-$ZENITH_SOURCE_DIGEST\" 'apps/web'");
    expect(contextDirFromBuildspec(spec)).toBe("apps/web");
    expect(contextDirFromBuildspec(dockerBuildspec())).toBe(".");
    expect(dockerBuildspec()).toContain('SOURCE_DIGEST" .');
  });
});

describe("AWS egress and metadata guard", () => {
  it("is installed before the Dockerfile builds, rejects both metadata addresses and aborts when it cannot take effect", () => {
    const spec = dockerBuildspec();
    const guard = spec.indexOf("ZENITH_EGRESS");
    expect(guard).toBeGreaterThan(spec.indexOf("docker login"));
    expect(guard).toBeLessThan(spec.indexOf("  build:"));
    expect(spec).toContain("-d 169.254.169.254 -j REJECT");
    expect(spec).toContain("-d 169.254.170.2 -j REJECT");
    expect(spec).toContain("iptables -I FORWARD 1 -j ZENITH_EGRESS");
    expect(spec).toContain('test "$(iptables -S FORWARD | sed -n 2p)"');
    expect(spec.match(/on-failure: ABORT/g)).toHaveLength(3);
    expect(spec).not.toContain("${");
  });

  it("recovers exactly the allowlist an executed buildspec declares", () => {
    const hosts = egressHosts(["packages.example.com"]);
    expect(hosts).toContain("packages.example.com");
    expect(DEFAULT_BUILD_EGRESS_HOSTS.every((h) => hosts.includes(h))).toBe(true);
    expect(hostsFromBuildspec(dockerBuildspec(hosts))).toEqual(hosts);
    expect(hostsFromBuildspec("version: 0.2\n")).toBeUndefined();
    expect(hostsFromBuildspec(dockerBuildspec(hosts) + egressGuardCommands(hosts).join("\n"))).toBeUndefined(); // a second guard line is not accepted
  });

  it.each(["a;rm -rf /", "$(id).example.com", "UPPER..example.com", "no_dots", "a b.example.com", ""])("refuses a hostname that is not a plain DNS name: %j", (host) => {
    expect(() => egressHosts([host])).toThrow(/plain DNS name/);
  });
});

describe("AWS build attestation", () => {
  const role = "arn:aws:iam::123456789012:role/zenith-api-build";
  const build = (over: Partial<Build> = {}): Build => ({
    id: "zenith-api:00000000-0000-4000-8000-000000000000",
    arn: "arn:aws:codebuild:us-east-1:123456789012:build/zenith-api:00000000-0000-4000-8000-000000000000",
    projectName: "zenith-api",
    serviceRole: role,
    timeoutInMinutes: 30,
    source: { type: "S3", buildspec: dockerBuildspec() },
    environment: { type: "LINUX_CONTAINER", image: "aws/codebuild/standard:7.0", computeType: "BUILD_GENERAL1_MEDIUM", privilegedMode: true },
    startTime: new Date("2026-09-30T11:50:00Z"),
    endTime: new Date("2026-09-30T11:58:00Z"),
    ...over,
  });

  it("reports the guarded build as allowlisted and passes the profile", () => {
    const att = awsBuildAttestation(build());
    expect(att.builderId).toBe("arn:aws:codebuild:us-east-1:123456789012:project/zenith-api");
    expect(att.isolation.network).toMatchObject({ egress: "allowlisted", verifiedBy: "provider_read" });
    expect(att.isolation.resources).toEqual({ timeoutSec: 1800, computeClass: "BUILD_GENERAL1_MEDIUM" });
    expect(assertBuildIsolation("aws", att.isolation, closed)).toEqual({ exceptions: [] });
  });

  it("reports a buildspec that is not the generated guarded one as unrestricted, which admission refuses", () => {
    const tampered = awsBuildAttestation(build({ source: { type: "S3", buildspec: dockerBuildspec().replace("169.254.169.254", "169.254.169.253") } }));
    expect(tampered.isolation.network.egress).toBe("unrestricted");
    expect(() => assertBuildIsolation("aws", tampered.isolation, closed)).toThrow(/egress was not restricted/);
    const noGuard = awsBuildAttestation(build({ source: { type: "S3", buildspec: "version: 0.2\nphases:\n  build:\n    commands:\n      - docker build .\n" } }));
    expect(noGuard.isolation.dependencies.downloads).toBe("direct");
  });

  it("does not call a service role other than the build role dedicated", () => {
    const att = awsBuildAttestation(build({ serviceRole: "arn:aws:iam::123456789012:role/zenith-deploy" }));
    expect(att.isolation.identity.dedicated).toBe(false);
    expect(() => assertBuildIsolation("aws", att.isolation, closed)).toThrow(BuildIsolationError);
  });
});

describe("GCP Cloud Build request bounds", () => {
  const base = {
    sourceBucket: "zenith-src",
    sourceObject: "bundle.tgz",
    imageRef: "us-central1-docker.pkg.dev/proj-12345/repo/web:tag",
    buildServiceAccount: "zenith-web-bld@proj-12345.iam.gserviceaccount.com",
  };
  it("bounds the timeout by the profile and accepts only a worker pool of the same project", () => {
    expect(validateBuildInput("proj-12345", { ...base, timeoutSeconds: 1800 })).toBeUndefined();
    expect(validateBuildInput("proj-12345", { ...base, timeoutSeconds: 3600 })).toMatch(/60-1800/);
    expect(validateBuildInput("proj-12345", { ...base, workerPool: "projects/proj-12345/locations/us-central1/workerPools/isolated" })).toBeUndefined();
    expect(validateBuildInput("proj-12345", { ...base, workerPool: "projects/other-proj/locations/us-central1/workerPools/isolated" })).toMatch(/worker pool/);
    expect(validateBuildInput("proj-12345", { ...base, workerPool: "projects/proj-12345/locations/us-central1/workerPools/../x" })).toMatch(/worker pool/);
  });
});
