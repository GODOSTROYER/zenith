/** Existing generic session behavior with modeled ports; supplemental readiness is separate. */
import { describe, expect, it } from "vitest";
import { createRuntime } from "@/lib/execution/runtime";
import { withProviderSession } from "@/lib/execution/session";
import { createWorld } from "./fakes/world";
import { ENV, OP, providerConnection } from "./fakes/fixtures";

describe("ordinary activity provider sessions",()=>{
  it("keeps planning and deployment sessions free of supplemental readiness admission",async()=>{
    const w=createWorld();
    try {
      const rt=createRuntime(w.deps),ec={op:{id:OP}},connection=providerConnection(),fence={scope:`env:${ENV}`,fenceToken:7};
      const plan=await withProviderSession(rt,ec,{purpose:"observe",capability:"infrastructure.plan",connection,fence},async()=>"planned");
      const deploy=await withProviderSession(rt,ec,{purpose:"deploy",connection,fence},async()=>"deployed");
      expect([plan,deploy]).toEqual(["planned","deployed"]);
      expect(w.broker.grants).toHaveLength(2);expect(w.credentials.sessions).toHaveLength(2);
      expect(w.credentials.sessions.map(value=>value.capability)).toEqual(["infrastructure.plan",w.ops.ops.get(OP)!.capability]);
      expect(w.credentials.sessions.every(value=>value.revoked)).toBe(true);
      expect(w.evidence.ofKind("observation")).toEqual([]);
    } finally {w.dispose();}
  });
  it("keeps ordinary read-only sessions using their single existing grant",async()=>{
    const w=createWorld();
    try {
      expect(await withProviderSession(createRuntime(w.deps),{op:{id:OP}},
        {purpose:"observe",capability:"infrastructure.observe",connection:providerConnection()},async()=>({count:1}))).toEqual({count:1});
      expect(w.broker.grants).toEqual([{operationId:OP,audience:"worker",capability:"infrastructure.observe"}]);
      expect(w.credentials.sessions).toHaveLength(1);
    } finally {w.dispose();}
  });
});
