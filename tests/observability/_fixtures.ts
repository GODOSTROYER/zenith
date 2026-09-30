/**
 * Shared builders for observability tests. Nothing here talks to a network.
 * Canary secrets are obviously fake but shaped like the real thing so the
 * redaction patterns recognize them.
 */
import type { AwsClientCtor, AwsSession, KubernetesSession } from "@/lib/credentials/types";
import type { PortableKind, ProviderKey, ResourceEdge, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { ObservabilitySource, QueryResult, SignalScope } from "@/lib/observability/types";

export const WS = "ws-1";
export const ENV = "env-1";
export const REGION = "us-east-1";

/** Fake secrets in real shapes. None of these are valid credentials. */
export const CANARY = {
  awsKeyId: "AKIAIOSFODNN7EXAMPLE",
  awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  bearer: "abcDEF123456ghiJKL789mno",
  password: "hunter2-CANARY-pw",
  dbUrlPassword: "s3cr3tDbPassCANARY",
  githubToken: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEACANARYKEYBODYCANARYKEYBODY\n-----END RSA PRIVATE KEY-----",
} as const;

export function node(address: string, kind: PortableKind | "provider_native", provider: ProviderKey, extra: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind,
    provider,
    region: REGION,
    nativeType: `${provider}:${kind}`,
    ownership: "managed",
    spec: {},
    origin: [],
    dependsOn: [],
    specDigest: "sha256:test",
    labels: {},
    ...extra,
  };
}

export function graph(nodes: ResourceNode[], edges: ResourceEdge[] = [], environmentId = ENV): ResourceGraph {
  return { version: 1, environmentId, manifestDigest: "sha256:m", nodes, edges, graphDigest: "sha256:g", notes: [] };
}

export const scope = (extra: Partial<SignalScope> = {}): SignalScope => ({ workspaceId: WS, environmentId: ENV, ...extra });

/** A range ending "now" (server clock) and `minutes` wide. */
export function recentRange(minutes = 60, now = Date.now()): { from: string; to: string } {
  return { from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now).toISOString() };
}

/**
 * An AWS session whose clients are built normally; tests intercept `send` with
 * aws-sdk-client-mock, so no credential resolution or network happens.
 */
export function fakeAwsSession(transport: AwsSession["transport"] = "direct"): AwsSession {
  return {
    provider: "aws",
    accountId: "123456789012",
    region: REGION,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    transport,
    client<C>(ctor: AwsClientCtor<C>): C {
      return new ctor({ region: REGION, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    },
    childProcessEnv: () => ({}),
  };
}

export function fakeKubeSession(kubeConfig: unknown): KubernetesSession {
  return { provider: "kubernetes", server: "https://kube.example.test", expiresAt: new Date(Date.now() + 900_000).toISOString(), kubeConfig: () => kubeConfig };
}

/** A programmable source for fabric tests. */
export function fakeSource(id: string, over: Partial<ObservabilitySource> = {}): ObservabilitySource {
  return { id, provider: "fake", supports: ["log"], ...over };
}

export const result = <T>(items: T[], over: Partial<QueryResult<T>> = {}): QueryResult<T> => ({
  items,
  sources: [],
  truncated: false,
  simulated: false,
  unavailable: [],
  ...over,
});

export const ARN = {
  ecsService: (cluster = "prod", service = "web") => `arn:aws:ecs:${REGION}:123456789012:service/${cluster}/${service}`,
  alb: (name = "web-alb", id = "50dc6c495c0c9188") => `arn:aws:elasticloadbalancing:${REGION}:123456789012:loadbalancer/app/${name}/${id}`,
  tg: (name = "web-tg", id = "73e2d6bc24d8a067") => `arn:aws:elasticloadbalancing:${REGION}:123456789012:targetgroup/${name}/${id}`,
  rds: (id = "orders-db") => `arn:aws:rds:${REGION}:123456789012:db:${id}`,
  sqs: (name = "jobs") => `arn:aws:sqs:${REGION}:123456789012:${name}`,
  cache: (id = "cache-001") => `arn:aws:elasticache:${REGION}:123456789012:cluster:${id}`,
  logGroup: (name: string) => `arn:aws:logs:${REGION}:123456789012:log-group:${name}:*`,
};

/** Parse a Go-style double-quoted literal at the start of `s`; returns value and the rest. */
export function parseGoString(s: string): { value: string; rest: string } {
  if (s[0] !== '"') throw new Error("literal must start with a quote");
  let i = 1;
  let out = "";
  for (;;) {
    if (i >= s.length) throw new Error("unterminated literal");
    const ch = s[i];
    if (ch === '"') return { value: out, rest: s.slice(i + 1) };
    if (ch === "\n" || ch === "\r") throw new Error("raw newline inside literal");
    if (ch === "\\") {
      const n = s[i + 1];
      if (n === "u") {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      const map: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };
      if (!(n in map)) throw new Error(`unknown escape \\${n}`);
      out += map[n];
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
}
