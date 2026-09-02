/**
 * Onboarding ships the sample compose file as a module (an fs read from
 * process.cwd() is not traced into a standalone build), while the importer
 * tests read the fixture off disk. Two copies drift unless something checks.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLE_COMPOSE } from "@/app/onboarding/sample-compose";

const FIXTURE = path.join(process.cwd(), "fixtures", "sample-app", "docker-compose.yml");

describe("SAMPLE_COMPOSE", () => {
  it("is exactly the fixture the importer tests parse", () => {
    expect(SAMPLE_COMPOSE).toBe(fs.readFileSync(FIXTURE, "utf8"));
  });

  it("is not empty — the point of the module is that it cannot go missing", () => {
    expect(SAMPLE_COMPOSE).toMatch(/^version: /);
  });
});
