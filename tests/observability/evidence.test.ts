import { describe, expect, it } from "vitest";
import { SOURCE_EVIDENCE } from "@/lib/observability/evidence";
import { KNOWN_SOURCE_IDS } from "@/lib/observability/sources/factory";

describe("source evidence levels", () => {
  it("every selectable source has an evidence entry with a stated basis", () => {
    for (const id of KNOWN_SOURCE_IDS) {
      expect(SOURCE_EVIDENCE[id], id).toBeDefined();
      expect(SOURCE_EVIDENCE[id].basis.length).toBeGreaterThan(10);
    }
  });

  it("nothing is labeled real or emulated: no live or emulator run has happened", () => {
    // Raise a level here only together with a recorded live/emulated acceptance run.
    for (const [id, e] of Object.entries(SOURCE_EVIDENCE)) {
      expect(["contract", "simulated"], id).toContain(e.level);
    }
  });

  it("only the sandbox source is simulated", () => {
    const simulated = Object.entries(SOURCE_EVIDENCE).filter(([, e]) => e.level === "simulated").map(([id]) => id);
    expect(simulated).toEqual(["sandbox.logsim"]);
  });
});
