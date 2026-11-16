/**
 * Portable SQL bindings authenticate through Cloud SQL IAM database login.
 * Real driver compilation only; no provider API or database login is exercised.
 * The new verb must produce exactly the existing instance-scoped login grant,
 * with no password, secret access or additional broad IAM role.
 */
import { describe, expect, it } from "vitest";
import { mapGrant } from "@/lib/providers/gcp/iam-roles";
import { GcpCompileError } from "@/lib/providers/gcp/errors";
import { compileContext, environmentNodes } from "./_fixtures";

describe("Postgres read_credentials", () => {
  it("maps the portable verb to the same deduplicated class as IAM database login", () => {
    expect(mapGrant("postgres", ["read_credentials"], "identity/web")).toEqual([{ kind: "cloudsql" }]);
    expect(mapGrant("postgres", ["connect", "read_credentials", "READ_CREDENTIALS"], "identity/web")).toEqual(mapGrant("postgres", ["connect"], "identity/web"));
  });

  it("creates only conditioned client/instanceUser bindings and an IAM service-account database user", () => {
    const nodes = environmentNodes().map((node) => node.address === "identity/web"
      ? { ...node, spec: { ...node.spec, grants: [{ target: "resource/db", access: ["read_credentials"], via: ["binding:sql"] }] } }
      : node);
    const fragments = compileContext(nodes).compileAll();
    const identity = fragments.get("identity/web")!;
    expect(Object.keys(identity.resource!).sort()).toEqual(["google_project_iam_member", "google_service_account", "google_sql_user"]);
    const bindings = Object.values(identity.resource!.google_project_iam_member);
    expect(bindings).toHaveLength(2);
    expect(bindings.map((body) => body.role).sort()).toEqual(["roles/cloudsql.client", "roles/cloudsql.instanceUser"]);
    for (const body of bindings) {
      expect(body.member).toBe("serviceAccount:${google_service_account.identity_web.email}");
      expect(body.condition).toEqual([expect.objectContaining({ expression: 'resource.name == "projects/${google_sql_database_instance.resource_db.project}/instances/${google_sql_database_instance.resource_db.name}" && resource.type == "sqladmin.googleapis.com/Instance"' })]);
    }
    const users = Object.values(identity.resource!.google_sql_user);
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({ instance: "${google_sql_database_instance.resource_db.name}", name: '${trimsuffix(google_service_account.identity_web.email, ".gserviceaccount.com")}', type: "CLOUD_IAM_SERVICE_ACCOUNT" });
    const database = fragments.get("resource/db")!;
    const instance = Object.values(database.resource!.google_sql_database_instance)[0];
    expect((instance.settings as { database_flags: unknown[] }[])[0].database_flags).toContainEqual({ name: "cloudsql.iam_authentication", value: "on" });
    expect(JSON.stringify({ identity, database })).not.toMatch(/secretAccessor|cloudsql\.admin|roles\/(owner|editor)|root_password|"password"/);
  });

  it.each(["object_store", "secret", "redis", "queue"])("does not add read_credentials to %s", (kind) => {
    expect(() => mapGrant(kind, ["read_credentials"], "identity/web")).toThrow(GcpCompileError);
  });

  it.each(["read_credential", "read_credentials:*", "admin", "*"])("keeps the unknown Postgres verb %s refused", (verb) => {
    expect(() => mapGrant("postgres", [verb], "identity/web")).toThrow(GcpCompileError);
  });
});
