/**
 * `gcp:service_account` — a workload identity: one user-managed service
 * account plus the least-privilege bindings derived from `IdentitySpec.grants`
 * (mapping rules and the accepted verbs are in `../../iam-roles.ts`).
 *
 * Compiles to (service account first):
 *   google_service_account
 *   one resource-level `*_iam_member` per grant class (bucket, topic,
 *     subscription, secret, repository, Cloud Run service), each on the EXACT
 *     target resource through `ctx.ref`, member `serviceAccount:<email>`
 *   Cloud SQL: two project-level members (`cloudsql.client`,
 *     `cloudsql.instanceUser`) each with an IAM condition pinning the instance
 *     name, plus a `google_sql_user` of type CLOUD_IAM_SERVICE_ACCOUNT. No
 *     password exists anywhere: the app authenticates with its service-account
 *     identity (IAM database authentication).
 *   logging: `roles/logging.logWriter` at project level (no narrower scope exists)
 *
 * Never: primitive roles, project-level editor/owner, `allUsers`, wildcard
 * members, keys (`google_service_account_key` is never compiled, so no key
 * material can be in state).
 *
 * Honest limits: IAM database users start with no table privileges; they need
 * `GRANT` statements run in the database (a migration step, capability
 * `database.migrate`). Memorystore for Redis has no IAM data-plane
 * authentication, so a `redis` grant compiles no binding.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { IdentitySpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { mapGrant, assertPredefinedRole } from "../../iam-roles";
import { cloudName, fnv6, tagDescription, tfLabel, tfSub, SUBSCRIPTION_SUFFIX } from "../../naming";
import { contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, lit, ref } from "../../hcl";
import { makeReaders, str, tail, type ReadSpec } from "../../read-kit";
import { workloadTrust } from "./workload-trust";

export const DRIVER_ID = "gcp.service_account@1";
const IAM = "https://iam.googleapis.com/v1";

function desiredAttributes(_node: ResourceNode): Record<string, unknown> {
  return { disabled: false };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_service_account", L, { account_id: lastSegment(node.externalRef, node.address).split("@")[0] });
  }
  const s = specOf<IdentitySpec>(node);
  const sa = `google_service_account.${L}`;
  const member = `serviceAccount:\${${sa}.email}`;
  const resource: NonNullable<TofuFragment["resource"]> = {
    google_service_account: {
      [L]: {
        account_id: cloudName(ctx.namePrefix, node.address, { max: 30, min: 6 }),
        display_name: `Zenith ${lit(String(s.workload ?? node.address)).slice(0, 80)}`,
        description: tagDescription(ctx.tags, node, "workload identity", 256),
      },
    },
  };
  const addresses = [sa];
  const add = (type: string, label: string, body: Record<string, unknown>) => {
    (resource[type] ??= {})[label] = body;
    addresses.push(`${type}.${label}`);
  };
  const trust = workloadTrust(node, ctx);
  if (trust.state === "ready") {
    add("google_service_account_iam_member", tfSub(node.address, "workload_trust"), {
      service_account_id: expr(`${sa}.name`),
      role: "roles/iam.workloadIdentityUser",
      member: `serviceAccount:${ref(ctx, trust.cluster.address, "project")}.svc.id.goog[${trust.namespace}/${trust.name}]`,
    });
  }

  for (const grant of s.grants ?? []) {
    const target = ctx.node(grant.target);
    if (!target) throw new GcpCompileError("unknown_target", `${node.address}: grant target ${lit(String(grant.target))} is not in the graph.`);
    const where = `${node.address} → ${grant.target}`;
    for (const m of mapGrant(target.kind, grant.access, where)) {
      const key = fnv6(`${grant.target}|${m.kind}|${m.role ?? ""}`);
      const g = tfSub(node.address, `g_${key}`);
      switch (m.kind) {
        case "object_store":
          add("google_storage_bucket_iam_member", g, { bucket: ref(ctx, target.address, "name"), role: assertPredefinedRole(m.role!), member });
          break;
        case "topic_publish":
          add("google_pubsub_topic_iam_member", g, { topic: ref(ctx, target.address, "name"), role: assertPredefinedRole(m.role!), member });
          break;
        case "queue_consume":
          // the subscription is a secondary resource of the queue node; its label is a pure function of the address
          add("google_pubsub_subscription_iam_member", g, { subscription: expr(`google_pubsub_subscription.${tfSub(target.address, SUBSCRIPTION_SUFFIX)}.name`), role: assertPredefinedRole(m.role!), member });
          break;
        case "secret":
          add("google_secret_manager_secret_iam_member", g, { secret_id: ref(ctx, target.address, "secret_id"), role: assertPredefinedRole(m.role!), member });
          break;
        case "registry":
          add("google_artifact_registry_repository_iam_member", g, {
            repository: ref(ctx, target.address, "name"),
            location: ctx.region,
            role: assertPredefinedRole(m.role!),
            member,
          });
          break;
        case "run_invoke":
          add("google_cloud_run_v2_service_iam_member", g, { name: ref(ctx, target.address, "name"), location: ctx.region, role: assertPredefinedRole(m.role!), member });
          break;
        case "log_write":
          add("google_project_iam_member", g, { project: expr(`${sa}.project`), role: assertPredefinedRole(m.role!), member });
          break;
        case "cloudsql": {
          const project = ref(ctx, target.address, "project");
          const name = ref(ctx, target.address, "name");
          const condition = {
            title: `zenith-${fnv6(target.address)}`,
            description: "Pins the binding to one Cloud SQL instance",
            expression: `resource.name == "projects/${project}/instances/${name}" && resource.type == "sqladmin.googleapis.com/Instance"`,
          };
          for (const role of ["roles/cloudsql.client", "roles/cloudsql.instanceUser"]) {
            add("google_project_iam_member", tfSub(node.address, `g_${fnv6(`${grant.target}|${role}`)}`), {
              project: expr(`${sa}.project`),
              role: assertPredefinedRole(role),
              member,
              condition: [condition],
            });
          }
          add("google_sql_user", tfSub(node.address, `sqluser_${fnv6(grant.target)}`), {
            instance: name,
            name: expr(`trimsuffix(${sa}.email, ".gserviceaccount.com")`),
            type: "CLOUD_IAM_SERVICE_ACCOUNT",
          });
          break;
        }
        case "redis":
          break; // no IAM data plane; network-level access is gcp:firewall_rule
      }
    }
  }
  return { resource, output: {
    [`${L}_email`]: { value: expr(`${sa}.email`), description: "workload service account email" },
    ...(trust.state === "unresolved" ? { [`${L}_trust_note`]: { value: lit(trust.note) } } : {}),
  }, addresses };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:service_account",
  kind: "identity",
  attributes: ["disabled"],
  resolve(ctx, externalId) {
    const m = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/serviceAccounts\/([A-Za-z0-9._@-]{6,100})$/.exec(String(externalId));
    if (!m || m[1] !== ctx.session.projectId) return { error: `externalId is not a service account in project ${ctx.session.projectId}.` };
    return { url: `${IAM}/${externalId}`, externalId: String(externalId) };
  },
  list: {
    url: (ctx) => `${IAM}/projects/${ctx.session.projectId}/serviceAccounts?pageSize=100`,
    itemsKey: "accounts",
    labelsOf: (item) => {
      // service accounts have no labels; Zenith tags ride in the description
      const out: Record<string, string> = {};
      const d = str(item.description) ?? "";
      for (const m of d.matchAll(/\b(zenith_[a-z_]+)=([a-z0-9_-]*)/g)) out[m[1]] = m[2];
      return out;
    },
  },
  extract(o) {
    const email = str(o.email);
    const project = str(o.projectId);
    if (!email || !project) throw new Error("no email/projectId");
    return {
      externalId: `projects/${project}/serviceAccounts/${email}`,
      name: tail(email),
      attributes: { disabled: o.disabled === true },
      native: { uniqueId: str(o.uniqueId), displayName: str(o.displayName) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const serviceAccountDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "identity",
  nativeType: "gcp:service_account",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
