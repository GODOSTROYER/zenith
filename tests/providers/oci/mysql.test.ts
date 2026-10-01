/** The pinned OCI schema has no safe MySQL password sink: never fake CREATE support. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mysqlDriver } from "@/lib/providers/oci/drivers/data/mysql";
import type { TofuFragment } from "@/lib/drivers/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { graphOf, node, tofuOnPath } from "../../tofu/_helpers";

describe("OCI MySQL creation safety", () => {
  it("keeps creation disabled and read capabilities available under oracle/oci 9.7.1", () => {
    expect(mysqlDriver.compile).toBeUndefined();
    expect(mysqlDriver.capabilities).toMatchObject({ compile: false, observe: true, runtime: true, verify: true, discover: true });
  });
  it("records the provider prerequisite using the checked-in real schema, not a mock write-only attribute", () => {
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "tests/providers/oci/fixtures/schema-9.7.1.json"), "utf8"));
    expect(schema.version).toBe("9.7.1");
    const mysql = schema.resource.oci_mysql_mysql_db_system;
    expect(mysql.attributes).toHaveProperty("admin_password");
    expect(Object.keys(mysql.attributes).filter((key) => /password.*_wo|password.*secret/i.test(key))).toEqual([]);
    expect(mysql.block_types).not.toHaveProperty("password_details");
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || !tofuOnPath())("OCI MySQL real pinned tofu validate negative controls (network)", () => {
  it.each(["admin_password_wo", "admin_password"])("refuses an ephemeral password in %s", async (argument) => {
    const fragment: TofuFragment = {
      ephemeral: { random_password: { bootstrap: { length: 32 } } },
      resource: { oci_mysql_mysql_db_system: { db: {
        availability_domain: "TEST:US-ASHBURN-AD-1", compartment_id: "ocid1.compartment.oc1..aaaaaaaa",
        shape_name: "MySQL.VM.Standard.E4.1.8GB", subnet_id: "ocid1.subnet.oc1.iad.aaaaaaaa", admin_username: "zenith_admin",
        [argument]: "${ephemeral.random_password.bootstrap.result}",
      } } }, addresses: ["oci_mysql_mysql_db_system.db"],
    };
    const ws = assembleWorkspace({ graph: graphOf([node("mysql/db", { provider: "oci" })]), fragments: new Map([["mysql/db", fragment]]),
      providerSet: "oci", region: "us-ashburn-1", backend: { kind: "local", path: "mysql.tfstate" }, tags: {} });
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(ws, {}, async (run) => {
      await run.init({ backend: false });
      const v = await run.validate();
      expect(v.valid).toBe(false);
      const errors = v.diagnostics.filter((d) => d.severity === "error");
      expect(errors.some((d) => argument.endsWith("_wo") ? /unsupported argument/i.test(d.summary) : /ephemeral/i.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
    });
  }, 900_000);
});
