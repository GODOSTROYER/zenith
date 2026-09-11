/**
 * Is LocalStack actually there? The health probe, the failure vocabulary it
 * reports in, and the preflight that turns either into something an operator
 * can act on. Split out of the single-file adapter; the code is unchanged.
 */
import { LOCALSTACK_ENDPOINT, PERMISSIONS } from "./clients";
import type { CloudConnection } from "@/lib/domain/types";
import type { PreflightReport, ProviderProbe } from "@/lib/providers/types";

/* --------------------------------- health --------------------------------- */

export interface LocalstackHealth {
  services?: Record<string, string>;
  edition?: string;
  version?: string;
}

/**
 * Why the health check failed. "Not reachable" is one of four outcomes, and
 * telling a user to start Docker when LocalStack answered with a 500 sends
 * them down the wrong path entirely.
 */
export type HealthFailure = "unreachable" | "timeout" | "http" | "malformed";

export type HealthResult =
  | { ok: true; health: LocalstackHealth }
  | { ok: false; kind: HealthFailure; detail: string; fix: string };

export const START_LOCALSTACK =
  "Start Docker Desktop, then run `localstack start` (or `docker run --rm -p 4566:4566 localstack/localstack`).";

export async function health(): Promise<HealthResult> {
  const url = `${LOCALSTACK_ENDPOINT}/_localstack/health`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return timedOut
      ? {
          ok: false,
          kind: "timeout",
          detail: `${url} did not answer within 2.5s.`,
          fix: "Something is listening but not responding — often a LocalStack container still starting up, or another process on this port. Wait a few seconds and re-check, or run `docker ps` to see what holds the port.",
        }
      : {
          ok: false,
          kind: "unreachable",
          detail: `Nothing answered at ${url} (${err instanceof Error ? err.message : String(err)}).`,
          fix: `${START_LOCALSTACK} Re-check here when it's up.`,
        };
  }

  if (!res.ok)
    return {
      ok: false,
      kind: "http",
      detail: `${url} answered ${res.status} ${res.statusText}.`,
      fix: "LocalStack is running but unhealthy. Check the container logs (`localstack logs` or `docker logs`), then restart it.",
    };

  try {
    return { ok: true, health: (await res.json()) as LocalstackHealth };
  } catch {
    return {
      ok: false,
      kind: "malformed",
      detail: `${url} answered 200, but the body was not JSON.`,
      fix: `Something other than LocalStack is serving ${LOCALSTACK_ENDPOINT}. Free the port, or point ZENITH_LOCALSTACK_ENDPOINT at the right one.`,
    };
  }
}

export const FAILURE_LABEL: Record<HealthFailure, string> = {
  unreachable: "LocalStack is not reachable",
  timeout: "LocalStack did not answer in time",
  http: "LocalStack answered, but is unhealthy",
  malformed: "Something other than LocalStack is on this port",
};

/**
 * Connection-free reachability check, exposed on the adapter as `probe` so
 * surfaces that offer LocalStack before any connection exists — onboarding's
 * "Available now" list — can ask whether it is actually up. One GET against
 * the health endpoint with a 2.5s timeout; safe to call on render.
 */
export async function probe(): Promise<ProviderProbe> {
  const h = await health();
  if (h.ok) {
    const running = Object.values(h.health.services ?? {}).filter(
      (s) => s === "running" || s === "available"
    ).length;
    return {
      reachable: true,
      detail: `LocalStack ${h.health.version ?? ""}${h.health.edition ? ` (${h.health.edition})` : ""} is up at ${LOCALSTACK_ENDPOINT} — ${running} service(s) available.`.replace(
        /\s+/g,
        " "
      ),
    };
  }
  return { reachable: false, detail: `${FAILURE_LABEL[h.kind]}. ${h.detail}`, fix: h.fix };
}

export async function preflight(_conn: CloudConnection): Promise<PreflightReport> {
  const result = await health();
  if (!result.ok) {
    return {
      ok: false,
      checks: [
        {
          id: "localstack.reachable",
          label: FAILURE_LABEL[result.kind],
          status: "fail",
          detail: result.detail,
          fix: result.fix,
        },
        {
          id: "localstack.scope",
          label: "Everything stays on this machine",
          status: "pass",
          detail: "This provider only ever talks to localhost. No cloud account is involved.",
        },
      ],
      permissions: PERMISSIONS,
    };
  }

  const h = result.health;
  const svc = h.services ?? {};
  const up = (name: string) => svc[name] === "running" || svc[name] === "available";
  const checks: PreflightReport["checks"] = [
    {
      id: "localstack.reachable",
      label: `LocalStack ${h.version ?? ""} is running${h.edition ? ` (${h.edition})` : ""}`,
      status: "pass",
      detail: `Health endpoint answered at ${LOCALSTACK_ENDPOINT}.`,
    },
    {
      id: "localstack.s3",
      label: "S3 (buckets provision for real)",
      status: up("s3") ? "pass" : "warn",
      detail: up("s3") ? "Buckets will be created in LocalStack." : "S3 service not reported as available.",
      fix: up("s3") ? undefined : "Ensure the s3 service is enabled in your LocalStack configuration.",
    },
    {
      id: "localstack.sqs",
      label: "SQS (queues provision for real)",
      status: up("sqs") ? "pass" : "warn",
      detail: up("sqs") ? "Queues will be created in LocalStack." : "SQS service not reported as available.",
      fix: up("sqs") ? undefined : "Ensure the sqs service is enabled in your LocalStack configuration.",
    },
    {
      id: "localstack.simulated",
      label: "Databases, caches, containers and load balancers are simulated",
      status: "warn",
      detail:
        "LocalStack Community has no RDS/ElastiCache/ECS/ALB, so those steps run as labeled local simulations. The exported Terraform provisions all of them for real on AWS.",
    },
  ];
  return { ok: true, checks, permissions: PERMISSIONS };
}
