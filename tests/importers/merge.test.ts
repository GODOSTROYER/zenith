import { describe, expect, it } from "vitest";
import { importDockerfile, importTerraform } from "@/lib/importers";
import { mergeImport } from "@/components/map/dialogs";

const DOCKERFILE = "FROM node:22-alpine\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]";
const TERRAFORM = 'resource "aws_s3_bucket" "assets" {}\nresource "aws_sqs_queue" "jobs" {}';

const names = (m: { services: { name: string }[]; resources: { name: string }[] }) => [
  ...m.services.map((s) => s.name),
  ...m.resources.map((r) => r.name),
];

/**
 * Importing Terraform or a Dockerfile appends to the working copy rather than
 * replacing it, so the only real logic is what happens when a name is already
 * taken. Nothing may be silently dropped or silently overwritten.
 */
describe("mergeImport", () => {
  const empty = { version: 1 as const, services: [], resources: [], routes: [], bindings: [] };

  it("appends an import to an empty system unchanged", () => {
    const incoming = importTerraform(TERRAFORM).manifest;
    const { manifest, renamed } = mergeImport(empty, incoming);
    expect(renamed).toEqual([]);
    expect(names(manifest)).toEqual(["assets", "jobs"]);
  });

  it("keeps everything that was already on the map", () => {
    const current = importDockerfile(DOCKERFILE, "web").manifest;
    const { manifest } = mergeImport(current, importTerraform(TERRAFORM).manifest);
    expect(names(manifest)).toEqual(["web", "assets", "jobs"]);
    expect(manifest.services[0]).toEqual(current.services[0]);
  });

  it("renames a colliding node instead of overwriting it, and says which", () => {
    const current = importDockerfile(DOCKERFILE, "app").manifest;
    const incoming = importDockerfile(DOCKERFILE, "app").manifest;
    const { manifest, renamed } = mergeImport(current, incoming);

    expect(manifest.services).toHaveLength(2);
    expect(names(manifest)).toEqual(["app", "app-2"]);
    expect(renamed).toEqual(["app → app-2"]);
    // the node that was already there keeps its name
    expect(manifest.services[0].name).toBe("app");
  });

  it("does not let two imported nodes collide with each other either", () => {
    const current = importDockerfile(DOCKERFILE, "app").manifest;
    const once = mergeImport(current, importDockerfile(DOCKERFILE, "app").manifest);
    const twice = mergeImport(once.manifest, importDockerfile(DOCKERFILE, "app").manifest);
    expect(names(twice.manifest)).toEqual(["app", "app-2", "app-3"]);
  });

  it("carries routes and bindings across as well", () => {
    const { manifest } = mergeImport(
      { ...empty, routes: [], bindings: [] },
      importTerraform(TERRAFORM).manifest
    );
    expect(manifest.routes).toEqual([]);
    expect(manifest.bindings).toEqual([]);
    expect(manifest.version).toBe(1);
  });
});
