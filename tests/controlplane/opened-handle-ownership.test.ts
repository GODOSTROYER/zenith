/** Opener ownership uses actual database handles; no cloud or provider permission proof. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPlatformDbHandle, isOpenedPlatformDbHandle, openPlatformDb, platformDb, resetPlatformDbForTests, PLATFORM_SCHEMA_VERSION,
  type Driver, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PG_URL } from "./_support/harness";

if (process.env.ZENITH_TEST_OPENED_HANDLE_REQUIRED === "1") {
  if (!PG_URL) throw new Error("Opened handle ownership acceptance requires owned PostgreSQL.");
  if (PLATFORM_SCHEMA_VERSION < 13) throw new Error("Opened handle ownership acceptance requires canonical schema13.");
}

it("does not register an exported executor with a structurally matching PostgreSQL driver",async () => {
  const run=vi.fn(async () => []);
  const driver:Driver={kind:"postgres",identity:"postgres://model.invalid/db",run,exec:async()=>{},
    transaction:async body=>body(driver),close:async()=>{}};
  const fake=createPlatformDbHandle(driver);
  expect(isOpenedPlatformDbHandle(fake)).toBe(false);
  expect(isOpenedPlatformDbHandle({...fake})).toBe(false);
  expect(run).not.toHaveBeenCalled();
});

describe.skipIf(!PG_URL)("opened platform handle ownership [postgres]",() => {
  let db:PlatformDbHandle;
  beforeAll(async()=>{db=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});},60_000);
  afterEach(()=>vi.unstubAllEnvs());
  afterAll(async()=>{await resetPlatformDbForTests();await db?.close();});
  it("recognizes only the real open PostgreSQL handle and refuses its copied shape",()=>{
    expect(isOpenedPlatformDbHandle(db,"postgres")).toBe(true);
    expect(isOpenedPlatformDbHandle({...db},"postgres")).toBe(false);
    expect(isOpenedPlatformDbHandle(db,"pglite")).toBe(false);
  });
  it.each(["query","tx","exec","close","identity","kind"] as const)("refuses an opened handle with replaced %s until its exact descriptor is restored",key=>{
    const descriptor=Object.getOwnPropertyDescriptor(db,key)!;
    try {
      Object.defineProperty(db,key,{...descriptor,value:key==="kind"?"pglite":key==="identity"?"postgres://other.invalid/db":vi.fn()});
      expect(isOpenedPlatformDbHandle(db,"postgres")).toBe(false);
    } finally {Object.defineProperty(db,key,descriptor);}
    expect(isOpenedPlatformDbHandle(db,"postgres")).toBe(true);
  });
  it("invalidates opener ownership synchronously when real close begins",async()=>{
    const opened=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
    const closing=opened.close();
    expect(isOpenedPlatformDbHandle(opened,"postgres")).toBe(false);
    await closing;
    expect(isOpenedPlatformDbHandle(opened,"postgres")).toBe(false);
  });
  it("retains genuine membership and the process-wide pool across module reload",async()=>{
    await resetPlatformDbForTests();
    vi.stubEnv("ZENITH_PLATFORM_DB","postgres");vi.stubEnv("ZENITH_PLATFORM_DB_URL",PG_URL!);vi.stubEnv("ZENITH_PLATFORM_DB_MAX","1");
    const first=await platformDb();
    vi.resetModules();
    const reloaded=await import("@/lib/controlplane/db/open");
    expect(await reloaded.platformDb()).toBe(first);
    expect(reloaded.isOpenedPlatformDbHandle(db,"postgres")).toBe(true);
    expect(reloaded.isOpenedPlatformDbHandle(first,"postgres")).toBe(true);
    await reloaded.resetPlatformDbForTests();
    expect(reloaded.isOpenedPlatformDbHandle(first)).toBe(false);
  });
  it("keeps a genuine PGlite handle unsupported as PostgreSQL without relabeling it",async()=>{
    const local=await openPlatformDb({kind:"pglite"});
    try {expect(isOpenedPlatformDbHandle(local,"pglite")).toBe(true);expect(isOpenedPlatformDbHandle(local,"postgres")).toBe(false);}
    finally {await local.close();}
    expect(isOpenedPlatformDbHandle(local)).toBe(false);
  });
});
