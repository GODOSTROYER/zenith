/** Modeled activity-port routing only; native owner/SDK integration has its separate PostgreSQL suite. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "@/lib/execution/runtime";
import { observeAwsBootstrapReadiness } from "@/lib/execution/aws-bootstrap-preflight";
import { StepFailedError } from "@/lib/execution/errors";
import { createWorld } from "./fakes/world";
import { ENV, OP, PLATFORM_CONNECTION } from "./fakes/fixtures";

const native=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/lib/platform/credentials",()=>({readNativeAwsBootstrapReadiness:native.read}));
afterEach(()=>{native.read.mockReset();});

describe("supplemental AWS readiness activity routing",()=>{
  it("requests a fresh weaker worker read grant with the native recorded fence and no caller inventory",async()=>{
    const w=createWorld();
    try {
      Object.assign(w.ops.ops.get(OP)!,{leaseScope:`env:${ENV}`,fenceToken:7});
      const result={status:"incomplete",roleCoverage:"incomplete"};native.read.mockResolvedValue(result);
      expect(await observeAwsBootstrapReadiness(createRuntime(w.deps),OP)).toBe(result);
      expect(w.broker.grants).toEqual([{operationId:OP,audience:"worker",fence:{scope:`env:${ENV}`,fenceToken:7},capability:"infrastructure.observe",durationSec:60}]);
      expect(native.read).toHaveBeenCalledOnce();
      const [owner,request]=native.read.mock.calls[0];
      expect(owner).toBe(w.credentials);expect(Object.keys(request).sort()).toEqual(["connectionId","grant"]);
      expect(request.connectionId).toBe(PLATFORM_CONNECTION);
      expect(request.grant).toMatchObject({op:OP,env:ENV,cap:"infrastructure.observe",aud:"worker",fence:7});
      expect(w.credentials.sessions).toEqual([]);
    } finally {w.dispose();}
  });
  it("refuses a missing native recorded fence before requesting any read grant",async()=>{
    const w=createWorld();
    try {await expect(observeAwsBootstrapReadiness(createRuntime(w.deps),OP)).rejects.toBeInstanceOf(StepFailedError);
      expect(w.broker.grants).toEqual([]);expect(native.read).not.toHaveBeenCalled();}
    finally {w.dispose();}
  });
  it("propagates native-owner refusal without obtaining a normal provider session",async()=>{
    const w=createWorld();
    try {Object.assign(w.ops.ops.get(OP)!,{leaseScope:`env:${ENV}`,fenceToken:7});
      native.read.mockRejectedValue(new StepFailedError("Native owner refused."));
      await expect(observeAwsBootstrapReadiness(createRuntime(w.deps),OP)).rejects.toBeInstanceOf(StepFailedError);
      expect(w.credentials.sessions).toEqual([]);}
    finally {w.dispose();}
  });
});
