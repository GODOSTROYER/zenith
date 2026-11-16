/** Minimal workspace assembly input (builtin provider set, local backend) for the typed-input tests. */
import type { AssembleWorkspaceInput } from "@/lib/tofu/workspace";
import { graphOf, node } from "../../tofu/_helpers";

export function builtinWorkspaceInput(inputs: AssembleWorkspaceInput["inputs"]): AssembleWorkspaceInput {
  return {
    graph: graphOf([node("resource/a")]),
    fragments: new Map([["resource/a", { resource: { terraform_data: { a: { input: "static" } } }, addresses: ["terraform_data.a"] }]]),
    providerSet: "builtin",
    region: "ap-south-1",
    backend: { kind: "local", path: "/tmp/zenith-typed-inputs-state/terraform.tfstate" },
    tags: {},
    ...(inputs ? { inputs } : {}),
  };
}
