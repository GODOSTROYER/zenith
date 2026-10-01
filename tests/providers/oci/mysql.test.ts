/**
 * OCI MySQL stays read-only until its pinned provider proves a safe password sink.
 * The checked-in schema is a projection, not evidence of write_only metadata.
 * Oracle's resource docs list admin_password, without a Vault password reference:
 * https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/mysql_mysql_db_system.html
 * OpenTofu requires provider-declared write-only attributes for ephemeral values:
 * https://opentofu.org/docs/v1.12/language/ephemerality/write-only-attributes/
 * Network checks below use the real locked 9.7.1 provider, never cloud credentials
 * or apply. They are unverified when the env gate is off or tofu cannot launch.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mysqlDriver } from "@/lib/providers/oci/drivers/data/mysql";
import type { TofuFragment } from "@/lib/drivers/types";
import { buildChildEnv } from "@/lib/tofu/env";
import { runProcess } from "@/lib/tofu/process";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { graphOf, node, tempDir, tofuOnPath } from "../../tofu/_helpers";
import { driverContext, FakeOci, json, ocid, zenithTagsFor } from "./_support";

interface SchemaBlock {
  attributes: Record<string, { type: unknown; optional?: boolean; computed?: boolean; write_only?: boolean }>;
  block_types: Record<string, { block: SchemaBlock }>;
}

const mysqlNode = node("mysql/db", {
  provider: "oci", kind: "mysql", nativeType: "oci:mysql_db_system", region: "us-ashburn-1",
  spec: { version: "8.4.6", highAvailability: true, backup: "daily" },
});
const passwordRef = "${ephemeral.random_password.bootstrap.result}";
const password: NonNullable<TofuFragment["ephemeral"]> = {
  random_password: { bootstrap: { length: 32, min_upper: 1, min_lower: 1, min_numeric: 1, min_special: 1 } },
};

/** Schema-only test configuration; it does not create a usable database. */
function mysqlFragment(extra: Record<string, unknown> = {}): TofuFragment {
  return {
    resource: { oci_mysql_mysql_db_system: { db: {
      availability_domain: "TEST:US-ASHBURN-AD-1", compartment_id: "ocid1.compartment.oc1..aaaaaaaa",
      shape_name: "MySQL.VM.Standard.E4.1.8GB", subnet_id: "ocid1.subnet.oc1.iad.aaaaaaaa", admin_username: "zenith_admin",
      ...extra,
    } } }, addresses: ["oci_mysql_mysql_db_system.db"],
  };
}

function workspace(fragment: TofuFragment) {
  return assembleWorkspace({ graph: graphOf([mysqlNode]), fragments: new Map([[mysqlNode.address, fragment]]),
    providerSet: "oci", region: mysqlNode.region, backend: { kind: "local", path: "mysql.tfstate" }, tags: {} });
}

describe("OCI MySQL creation safety", () => {
  it("keeps creation disabled and read capabilities available under oracle/oci 9.7.1", () => {
    expect(mysqlDriver.compile).toBeUndefined();
    expect(mysqlDriver.capabilities).toMatchObject({ compile: false, observe: true, runtime: true, verify: true, discover: true });
    expect(mysqlDriver.capabilities.evidence).not.toHaveProperty("compile");
    expect(Object.values(mysqlDriver.capabilities.evidence)).toEqual(["contract", "contract", "contract", "contract"]);
  });

  it("records the state-backed password and absent safe alternatives in the pinned fixture", () => {
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "tests/providers/oci/fixtures/schema-9.7.1.json"), "utf8")) as {
      version: string; provider: string; resource: Record<string, SchemaBlock>;
    };
    expect(schema.version).toBe("9.7.1");
    expect(schema.provider).toBe("oracle/oci");
    const mysql = schema.resource.oci_mysql_mysql_db_system;
    expect(mysql.attributes.admin_password).toMatchObject({ type: "string", optional: true, computed: true });
    expect(Object.keys(mysql.attributes).filter((key) => /password.*_wo|password.*secret/i.test(key))).toEqual([]);
    expect(mysql.block_types).not.toHaveProperty("password_details");
  });

  it("assembles only an ephemeral reference for the persistence negative control, never a password value", () => {
    const ws = workspace({ ...mysqlFragment({ admin_password: passwordRef }), ephemeral: password });
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);
    expect(main.resource.oci_mysql_mysql_db_system.db.admin_password).toBe(passwordRef);
    expect(main.ephemeral).toEqual(password);
    expect(ws.addressMap).toEqual({ [mysqlNode.address]: ["oci_mysql_mysql_db_system.db"] });
    expect(main).not.toHaveProperty("output");
    expect(main).not.toHaveProperty("data");
    expect(JSON.stringify(main)).not.toContain("admin_password_wo");
  });

  it("never copies password fields from mocked provider responses into read evidence", async () => {
    const canary = "OCI_MYSQL_PASSWORD_CANARY_8m!";
    const id = ocid("mysqldbsystem", "mysql");
    const item = { id, lifecycleState: "ACTIVE", displayName: "mysql", shapeName: "MySQL.VM.Standard.E4.1.8GB",
      mysqlVersion: "8.4.6", isHighlyAvailable: true, backupPolicy: { isEnabled: true }, freeformTags: zenithTagsFor(mysqlNode.address),
      adminPassword: canary, admin_password: canary, admin_password_wo: canary, passwordDetails: { password: canary } };
    const oci = new FakeOci();
    oci.route("GET", `/20190415/dbSystems/${id}`, json(item));
    oci.route("GET", "/20190415/dbSystems", json({ items: [item] }));
    const logs: string[] = [];
    const ctx = driverContext(oci, { log: (line) => logs.push(line) });
    const observation = await mysqlDriver.observe!(ctx, mysqlNode, id);
    const runtime = await mysqlDriver.runtime!(ctx, mysqlNode, id);
    const verification = await mysqlDriver.verify!(ctx, mysqlNode, observation, runtime);
    const discovered = await mysqlDriver.discover!(ctx);
    expect(observation.presence).toBe("present");
    expect(verification.status).toBe("passed");
    expect(discovered).toHaveLength(1);
    expect(JSON.stringify({ observation, runtime, verification, discovered, logs, calls: oci.calls })).not.toContain(canary);
    expect(oci.methods.every((method) => method === "GET")).toBe(true);
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || !tofuOnPath())("OCI MySQL real pinned tofu schema and persistence controls (network)", () => {
  it("validates the schema-only baseline and verifies the live password schema", async () => {
    const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
    await runner.run(workspace(mysqlFragment()), {}, async (run) => {
      // `providers schema` needs an initialized backend (local, inside the run's workdir).
      await run.init();
      const validation = await run.validate();
      expect(validation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(validation.valid).toBe(true);

      // Inspect the actual provider, including metadata omitted by the fixture.
      const temporary = tempDir("zenith-mysql-schema-");
      try {
        const cli = path.join(temporary.dir, "tofu.rc");
        writeFileSync(cli, "");
        const env = buildChildEnv({ homeDir: temporary.dir, tmpDir: temporary.dir,
          cliConfigFile: cli, pluginCacheDir: temporary.dir });
        const schema = await runProcess({ file: (await runner.binary()).bin, args: ["providers", "schema", "-json"],
          cwd: run.workDir, env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024, captureStdoutBytes: 64 * 1024 * 1024 });
        expect(schema.exitCode).toBe(0);
        expect(schema.stdoutOverflow).toBe(false);
        const parsed = JSON.parse(schema.stdout ?? "") as {
          provider_schemas: Record<string, { resource_schemas: Record<string, { block: SchemaBlock }> }>;
        };
        const mysql = parsed.provider_schemas["registry.opentofu.org/oracle/oci"].resource_schemas.oci_mysql_mysql_db_system.block;
        expect(mysql.attributes.admin_password).toMatchObject({ type: "string", optional: true, computed: true });
        expect(mysql.attributes.admin_password.write_only).not.toBe(true);
        expect(mysql.attributes).not.toHaveProperty("admin_password_wo");
        expect(mysql.block_types).not.toHaveProperty("password_details");
      } finally { temporary.cleanup(); }
    });
  }, 900_000);

  it.each(["admin_password", "output"] as const)("refuses persisting an ephemeral password through %s", async (sink) => {
    const fragment: TofuFragment = { ...mysqlFragment(sink === "admin_password" ? { admin_password: passwordRef } : {}),
      ephemeral: password, ...(sink === "output" ? { output: { password: { value: passwordRef, sensitive: true } } } : {}) };
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(workspace(fragment), {}, async (run) => {
      await run.init({ backend: false });
      const validation = await run.validate();
      expect(validation.valid).toBe(false);
      const errors = validation.diagnostics.filter((d) => d.severity === "error");
      // Diagnostic wording may vary; require both ephemerality and the rejected sink.
      expect(errors.some((d) => /ephemeral/i.test(`${d.summary} ${d.detail ?? ""}`)
        && new RegExp(sink, "i").test(`${d.summary} ${d.detail ?? ""}`)), JSON.stringify(errors)).toBe(true);
    });
  }, 900_000);

  it.each(["admin_password_wo", "zenith_not_a_mysql_argument"] as const)("rejects the unsupported MySQL property %s in JSON configuration", async (argument) => {
    const fragment: TofuFragment = { ...mysqlFragment({ [argument]: argument === "admin_password_wo" ? passwordRef : true }),
      ...(argument === "admin_password_wo" ? { ephemeral: password } : {}) };
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(workspace(fragment), {}, async (run) => {
      await run.init({ backend: false });
      const validation = await run.validate();
      expect(validation.valid).toBe(false);
      const errors = validation.diagnostics.filter((d) => d.severity === "error");
      // HCL JSON reports "Extraneous JSON object property", whereas native HCL
      // reports "Unsupported argument". The old summary-only regex depended
      // on syntax-specific wording; require the rejected name in the detail.
      expect(errors.some((d) => /extraneous json object property|unsupported argument/i.test(d.summary)
        && d.detail?.includes(`"${argument}"`)), JSON.stringify(errors)).toBe(true);
    });
  }, 900_000);
});
