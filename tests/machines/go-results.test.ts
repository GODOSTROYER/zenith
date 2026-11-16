/** Cross-language contract: real Go result mappers over fixtures, no live-host claims. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IMPLEMENTED_OPERATIONS, MachineArgsSchemas, MachineFailureDataSchema, MachineResultDataSchemas, type ImplementedOperation } from "@/lib/machines";

const dir = path.join(process.cwd(), "go/internal/machine/testdata/results");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("Go machine result goldens", () => {
  it("has a success fixture for every implemented operation", () => {
    expect(files.filter((f) => IMPLEMENTED_OPERATIONS.includes(f.slice(0, -5) as ImplementedOperation)).sort()).toEqual(IMPLEMENTED_OPERATIONS.map((op) => `${op}.json`).sort());
  });
  it.each(files)("%s matches the normalized args and exact result contract", (file) => {
    const f = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { operation: ImplementedOperation; args: unknown; result: { ok: boolean; data: unknown; output?: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean } } };
    expect(MachineArgsSchemas[f.operation].parse(f.args)).toEqual(f.args);
    const schema = f.result.ok ? MachineResultDataSchemas[f.operation] : MachineFailureDataSchema;
    expect(schema.parse(f.result.data)).toEqual(f.result.data);
    if (f.result.output) {
      expect(typeof f.result.output.stdout).toBe("string");
      expect(typeof f.result.output.stderr).toBe("string");
      expect(typeof f.result.output.truncated).toBe("boolean");
      expect((f.result.data as { exitCode: number }).exitCode).toEqual(f.result.output.exitCode);
    }
  });
});
