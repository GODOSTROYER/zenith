import { describe, expect, it } from "vitest";
import { findDriver, getDriver, listDrivers } from "@/lib/drivers/types";
import { NATIVE_TYPE_TABLE, kindsForNativeType } from "@/lib/resources/native-types";
import { AZURE_DRIVERS, registerAzureDrivers } from "@/lib/providers/azure/drivers";

describe("driver registration", () => {
  it("registers each driver under exactly the native type the shared table names for its kind", () => {
    registerAzureDrivers();
    registerAzureDrivers(); // idempotent
    expect(listDrivers("azure")).toHaveLength(AZURE_DRIVERS.length);
    for (const d of AZURE_DRIVERS) {
      expect(getDriver("azure", d.nativeType)).toBe(d);
      // the kind the driver serves must map to this native type in the table
      expect(NATIVE_TYPE_TABLE.azure[d.kind as keyof typeof NATIVE_TYPE_TABLE.azure], `${d.id}`).toBe(d.nativeType);
      expect(kindsForNativeType("azure", d.nativeType)).toContain(d.kind);
    }
  });

  it("native types the table names but no driver implements stay unregistered (visibly unsupported, not faked)", () => {
    registerAzureDrivers();
    for (const t of ["azure:mysql_flexible_server", "azure:virtual_machine", "azure:function_app", "azure:static_web_app", "azure:aks_cluster", "azure:managed_disk"]) {
      expect(findDriver("azure", t), t).toBeUndefined();
    }
  });

  it("every driver id is unique and follows the convention", () => {
    const ids = AZURE_DRIVERS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of AZURE_DRIVERS) expect(d.id).toBe(`azure.${d.nativeType.slice("azure:".length)}@1`);
  });
});
