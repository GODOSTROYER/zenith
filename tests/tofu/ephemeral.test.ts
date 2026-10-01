/** Offline C5 contract: deterministic merge, ownership, pins and safe ingress. */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { stableJson } from "@/lib/tofu/stable";
import { assembleWorkspace, assertWorkspaceIntact, configDigestOf } from "@/lib/tofu/workspace";
import { graphOf, node } from "./_helpers";
import { secVectors } from "./_expression-vectors";

const fragment = (label = "bootstrap"): TofuFragment => ({ ephemeral: { random_password: { [label]: { length: 32, min_special: 1 } } }, addresses: [] });
function assemble(fragments = new Map([["mysql/db", fragment()]]), ownership: "managed" | "referenced" | "external" = "managed") {
  return assembleWorkspace({ graph: graphOf([...fragments.keys()].map((address) => node(address, { ownership }))), fragments,
    providerSet: "random", region: "ap-south-1", backend: { kind: "local", path: "state.tfstate" }, tags: {} });
}
function replaceMain(ws: TofuWorkspace, main: unknown): TofuWorkspace {
  const files = ws.files.map((f) => f.path === "main.tf.json" ? { ...f, content: stableJson(main) } : f);
  return { ...ws, files, configDigest: configDigestOf(files) };
}
const mainOf = (ws: TofuWorkspace) => JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);

describe("ephemeral workspace fragments", () => {
  it("renders ephemeral blocks with deterministic bytes and no state addresses", () => {
    const fragments = new Map([["mysql/b", fragment("b")], ["mysql/a", fragment("a")]]);
    const first = assemble(fragments);
    expect(assemble(new Map([...fragments].reverse()))).toEqual(first);
    expect(mainOf(first)).toEqual({ ephemeral: { random_password: { a: { length: 32, min_special: 1 }, b: { length: 32, min_special: 1 } } } });
    expect(first.addressMap).toEqual({ "mysql/a": [], "mysql/b": [] });
    expect(() => assertWorkspaceIntact(first)).not.toThrow();
  });

  it("recognizes explicitly claimed ephemeral definitions without publishing them as plan addresses", () => {
    const f = fragment();
    f.addresses = ["ephemeral.random_password.bootstrap"];
    expect(assemble(new Map([["mysql/db", f]])).addressMap["mysql/db"]).toEqual([]);
    f.addresses = ["ephemeral.random_password.missing"];
    expect(() => assemble(new Map([["mysql/db", f]]))).toThrow(/does not define/);
  });

  it("rejects duplicate ephemeral definitions, including unclaimed definitions", () => {
    expect(() => assemble(new Map([["mysql/a", fragment()], ["mysql/b", fragment()]]))).toThrow(/defined by both/);
  });

  it("keeps managed and ephemeral addresses in separate namespaces", () => {
    const f = fragment();
    f.resource = { random_password: { bootstrap: { length: 32 } } };
    f.addresses = ["random_password.bootstrap"];
    expect(assemble(new Map([["mysql/db", f]])).addressMap["mysql/db"]).toEqual(f.addresses);
  });

  it.each(["referenced", "external"] as const)("refuses ephemeral blocks on a %s node", (ownership) => {
    expect(() => assemble(undefined, ownership)).toThrow(/not managed/);
  });

  it("accepts ephemeral references only when ephemeral blocks are declared", () => {
    const f = fragment();
    f.resource = { random_password: { fake: { password_wo: "${ephemeral.random_password.bootstrap.result}" } } };
    expect(() => assemble(new Map([["mysql/db", f]]))).not.toThrow();
    delete f.ephemeral;
    expect(() => assemble(new Map([["mysql/db", f]]))).toThrow(/reference root ephemeral/);
  });

  it.each([
    null, [], { random_password: [] }, { random_password: { invalid: [] } },
    { "bad.type": { p: {} } }, { random_password: { "bad.name": {} } },
    { aws_secretsmanager_secret_version: { p: {} } }, { terraform_data: { p: {} } },
  ])("refuses invalid structure or a provider outside the set (%j)", (ephemeral) => {
    expect(() => assemble(new Map([["mysql/db", { ephemeral, addresses: [] } as unknown as TofuFragment]]))).toThrow();
  });

  it.each(["provisioner", "connection"])("refuses %s in ephemeral blocks", (key) => {
    const f = { ephemeral: { random_password: { p: { [key]: {} } } }, addresses: [] };
    expect(() => assemble(new Map([["mysql/db", f]]))).toThrow(/run commands/);
    const queued = replaceMain(assemble(), { ephemeral: f.ephemeral });
    expect(() => assertWorkspaceIntact(queued)).toThrow(/run commands/);
  });

  it.each([...secVectors, '${nonsensitive(ephemeral.random_password.bootstrap.result)}', '${timestamp()}', '${provider::random::password()}'])("rejects hostile templates in ephemeral values and keys: %s", (source) => {
    for (const body of [{ length: source }, { [source]: 32 }]) {
      const f = { ephemeral: { random_password: { bootstrap: body } }, addresses: [] };
      expect(() => assemble(new Map([["mysql/db", f]]))).toThrow();
      expect(() => assertWorkspaceIntact(replaceMain(assemble(), { ephemeral: f.ephemeral }))).toThrow();
    }
  });

  it("never echoes hostile values or labels in a refusal", () => {
    const marker = "SYNTHETIC_SECRET_MARKER";
    const f = { ephemeral: { random_password: { bootstrap: { length: `\${file("${marker}")}` } } }, addresses: [] };
    try { assemble(new Map([["mysql/db", f]])); throw new Error("accepted"); }
    catch (e) { expect(e).toMatchObject({ code: "forbidden_construct" }); expect((e as Error).message).not.toContain(marker); }
    expect(() => assemble(new Map([["mysql/db", { ephemeral: { random_password: { [`${marker}.bad`]: {} } }, addresses: [] }]]))).toThrow(/invalid block name/);
  });

  it("rechecks structure, exact provider pins and duplicate definitions after queue serialization", () => {
    const ws = assemble();
    expect(() => assertWorkspaceIntact(replaceMain(ws, { ephemeral: { aws_secretsmanager_secret_version: { p: {} } } }))).toThrow(/pinned provider set/);
    expect(() => assertWorkspaceIntact(replaceMain(ws, { ephemeral: [] }))).toThrow(/must be an object/);
    const files = ws.files.map((f) => f.path === "versions.tf.json" ? { ...f, content: f.content.replace('"hashicorp/random"', '"attacker/random"') } : f);
    expect(() => assertWorkspaceIntact({ ...ws, files, configDigest: configDigestOf(files) })).toThrow(/pinned provider set/);
    const duplicated = [...ws.files, { path: "duplicate.tf.json", content: stableJson(mainOf(ws)) }];
    expect(() => assertWorkspaceIntact({ ...ws, files: duplicated, configDigest: configDigestOf(duplicated) })).toThrow(/duplicate ephemeral address/);
  });
});
