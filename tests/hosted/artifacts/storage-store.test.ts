/**
 * The artifact store over object storage.
 *
 * The filesystem store gets create-only from one `rename`; this one has to buy
 * it, so the claims worth testing are exactly the ones that purchase is made
 * of: every file is uploaded *before* the manifest that lists it, nothing is
 * ever uploaded with upsert on, a second put of the same bytes verifies instead
 * of rewriting, the manifest is fetched once per digest, a `Range` is handed to
 * Storage rather than served by downloading the whole object and slicing, and
 * `remove` clears the whole prefix starting with the manifest.
 *
 * Two suites, one subject:
 *
 *  - the mocked suite, which always runs, answers every Storage call from an
 *    in-memory bucket that enforces the same rules the real one does (409 on a
 *    duplicate create, 206 on a range, folder entries in a listing);
 *  - the live suite, which runs only under `ZENITH_CONTRACT_POSTGRES=1` with
 *    the Supabase URL and service-role key exported, puts a tiny bundle into
 *    the **real** bucket under a `contract-` prefix, reads it back byte for
 *    byte, asks for a range, and deletes exactly what it wrote in `afterAll`.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const DATA = isolatedDataDir("zenith-p1e-storage-");

let artifacts: typeof import("@/lib/hosted/artifacts");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  artifacts = await import("@/lib/hosted/artifacts");
  contracts = await import("@/lib/hosted/contracts");
});

afterAll(() => removeDir(DATA));

let counter = 0;

/** A believable build output: index.html, a hashed asset, a nested public file. */
function outputTree(overrides: Record<string, string> = {}): string {
  const dir = path.join(DATA, `out-${++counter}`);
  const files: Record<string, string> = {
    "index.html": '<!doctype html><title>Minimal app</title><script type="module" src="/assets/index-abc.js"></script>',
    "assets/index-abc.js": "console.log('Minimal app OK')",
    "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ...overrides,
  };
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

const provenance = (): import("@/lib/hosted/contracts").ArtifactProvenance => ({
  sourceDigest: "a".repeat(64),
  sourceKind: "tarball",
  jobId: "11111111-1111-4111-8111-111111111111",
  recipe: contracts.RECIPE_V1,
  contractVersion: 1,
  schemaVersion: 1,
  builtBy: "recipe-local",
  buildBoundary: "test double",
  builtAt: new Date().toISOString(),
});

/* ------------------------------ the fake bucket ----------------------------- */

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  range?: string;
}

/**
 * An in-memory Supabase Storage, honest about the four behaviours the store
 * depends on: create-only uploads answer 409, a `range` header answers 206 with
 * only those bytes, a listing reports folders as entries with a null id, and a
 * delete takes a list of exact keys.
 */
function fakeStorage(bucket: string) {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const calls: Call[] = [];

  const headerMap = (init?: RequestInit): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      out[k.toLowerCase()] = v;
    return out;
  };

  const bodyBuffer = (body: BodyInit | null | undefined): Buffer => {
    if (body === null || body === undefined) return Buffer.alloc(0);
    if (typeof body === "string") return Buffer.from(body, "utf8");
    return Buffer.from(body as Uint8Array);
  };

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const rest = url.pathname.replace("/storage/v1/", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerMap(init);
    calls.push({ method, path: decodeURIComponent(rest), headers, range: headers.range });

    const listPrefix = `object/list/${bucket}`;
    const objectPrefix = `object/${bucket}`;

    if (method === "POST" && rest === listPrefix) {
      const { prefix } = JSON.parse(bodyBuffer(init?.body).toString("utf8")) as { prefix: string };
      const base = prefix === "" ? "" : `${prefix}/`;
      const entries = new Map<string, { name: string; id: string | null }>();
      for (const key of objects.keys()) {
        if (!key.startsWith(base)) continue;
        const rel = key.slice(base.length);
        const cut = rel.indexOf("/");
        const name = cut === -1 ? rel : rel.slice(0, cut);
        entries.set(name, { name, id: cut === -1 ? `id-${name}` : null });
      }
      return new Response(JSON.stringify([...entries.values()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "DELETE" && rest === objectPrefix) {
      const { prefixes } = JSON.parse(bodyBuffer(init?.body).toString("utf8")) as { prefixes: string[] };
      for (const key of prefixes) objects.delete(key);
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (rest.startsWith(`${objectPrefix}/`)) {
      const key = decodeURIComponent(rest.slice(objectPrefix.length + 1));
      if (method === "POST") {
        if (objects.has(key))
          return new Response(JSON.stringify({ error: "Duplicate", message: "The resource already exists" }), {
            status: 409,
          });
        objects.set(key, { bytes: bodyBuffer(init?.body), contentType: headers["content-type"] ?? "" });
        return new Response(JSON.stringify({ Key: `${bucket}/${key}` }), { status: 200 });
      }
      if (method === "GET") {
        const held = objects.get(key);
        if (!held) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
        if (!range) return new Response(new Uint8Array(held.bytes), { status: 200 });
        const [, rawStart = "0", rawEnd = "0"] = range;
        const slice = held.bytes.subarray(Number(rawStart), Number(rawEnd) + 1);
        return new Response(new Uint8Array(slice), {
          status: 206,
          headers: { "content-range": `bytes ${rawStart}-${rawEnd}/${held.bytes.length}` },
        });
      }
    }
    return new Response(JSON.stringify({ error: "unhandled" }), { status: 500 });
  }) as unknown as typeof fetch;

  return { objects, calls, fetch: impl };
}

const BUCKET = "zenith-artifacts";

function mockedStore(prefix = "") {
  const storage = fakeStorage(BUCKET);
  const store = new artifacts.StorageArtifactStore({
    url: "https://project.example.supabase.co",
    key: "service-role-double",
    bucket: BUCKET,
    prefix,
    fetch: storage.fetch,
  });
  return { store, storage };
}

/* -------------------------------- mocked suite ------------------------------ */

describe("StorageArtifactStore (mocked Storage)", () => {
  it("uploads every file before the manifest, under sha256/<digest>/", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());

    const uploads = storage.calls
      .filter((c) => c.method === "POST" && !c.path.includes("object/list/"))
      .map((c) => c.path.replace(`object/${BUCKET}/`, ""));
    expect(uploads).toEqual([
      `sha256/${artifact.digest}/files/assets/index-abc.js`,
      `sha256/${artifact.digest}/files/favicon.svg`,
      `sha256/${artifact.digest}/files/index.html`,
      `sha256/${artifact.digest}/manifest.json`,
    ]);
    // The manifest is the only thing a reader consults, and it is last.
    expect(uploads.at(-1)).toBe(`sha256/${artifact.digest}/manifest.json`);
    expect([...storage.objects.keys()].sort()).toEqual(uploads.slice().sort());
    expect(storage.calls.filter((c) => c.method === "POST").every((c) => c.headers["x-upsert"] !== "true")).toBe(true);
    expect(artifact.fileCount).toBe(3);
  });

  it("is create-only: a second put of the same bytes verifies and uploads nothing", async () => {
    const { store, storage } = mockedStore();
    const first = await store.put(outputTree(), provenance());
    const before = [...storage.objects.keys()].sort();
    storage.calls.length = 0;

    const second = await store.put(outputTree(), provenance());

    expect(second.digest).toBe(first.digest);
    expect(second.createdAt).toBe(first.createdAt); // the stored record, not a new one
    expect(storage.calls.filter((c) => c.method === "POST" && c.path.startsWith(`object/${BUCKET}/`))).toEqual([]);
    expect([...storage.objects.keys()].sort()).toEqual(before);
  });

  it("refuses a put whose stored manifest no longer matches the built bytes", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());
    const key = `sha256/${artifact.digest}/manifest.json`;
    const held = storage.objects.get(key);
    const edited = JSON.parse(String(held?.bytes)) as import("@/lib/hosted/artifacts").ArtifactManifest;
    edited.files[0]!.sha256 = "b".repeat(64);
    storage.objects.set(key, { bytes: Buffer.from(JSON.stringify(edited)), contentType: "application/json" });

    const fresh = new artifacts.StorageArtifactStore({
      url: "https://project.example.supabase.co",
      key: "service-role-double",
      bucket: BUCKET,
      fetch: storage.fetch,
    });
    await expect(fresh.put(outputTree(), provenance())).rejects.toMatchObject({ code: "conflict" });
  });

  it("memoises the manifest per digest: get, list and open share one fetch", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());
    storage.calls.length = 0;

    await store.get(artifact.digest);
    await store.get(artifact.digest);
    await store.list(artifact.digest);
    await store.open(artifact.digest, "index.html");

    const manifestReads = storage.calls.filter((c) => c.method === "GET" && c.path.endsWith("manifest.json"));
    expect(manifestReads).toHaveLength(0); // the put's own manifest is already cached
    expect(await store.get("z".repeat(64))).toBeNull();
    expect(await store.list("z".repeat(64))).toEqual([]);
  });

  it("fetches the manifest exactly once for a digest it has not seen", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());
    const cold = new artifacts.StorageArtifactStore({
      url: "https://project.example.supabase.co",
      key: "service-role-double",
      bucket: BUCKET,
      fetch: storage.fetch,
    });
    storage.calls.length = 0;

    await cold.get(artifact.digest);
    await cold.list(artifact.digest);
    await cold.open(artifact.digest, "index.html");

    expect(storage.calls.filter((c) => c.method === "GET" && c.path.endsWith("manifest.json"))).toHaveLength(1);
  });

  it("open without a Range returns the whole file and its manifest record", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());
    storage.calls.length = 0;

    const opened = await store.open(artifact.digest, "assets/index-abc.js");

    expect(opened?.bytes.toString("utf8")).toBe("console.log('Minimal app OK')");
    expect(opened?.file.contentType).toBe("text/javascript");
    expect(storage.calls.every((c) => c.range === undefined)).toBe(true);
    expect(await store.open(artifact.digest, "../secret")).toBeNull();
    expect(await store.open(artifact.digest, "not-there.js")).toBeNull();
  });

  it("open with a Range forwards it to Storage and returns only those bytes", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());
    storage.calls.length = 0;

    const opened = await store.open(artifact.digest, "assets/index-abc.js", { start: 8, end: 11 });

    expect(opened?.bytes.toString("utf8")).toBe("console.log('Minimal app OK')".slice(8, 12));
    // The size and the etag source stay the whole file's, which is what a 206
    // needs for its content-range and what a 416 needs for `bytes */size`.
    expect(opened?.file.bytes).toBe("console.log('Minimal app OK')".length);
    expect(opened?.file.sha256).toHaveLength(64);
    const read = storage.calls.filter((c) => c.method === "GET");
    expect(read).toHaveLength(1);
    expect(read[0]!.range).toBe("bytes=8-11");
  });

  it("verify passes on stored bytes and names a file the manifest does not list", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());

    expect(await store.verify(artifact.digest)).toMatchObject({ ok: true });

    storage.objects.set(`sha256/${artifact.digest}/files/extra.txt`, {
      bytes: Buffer.from("smuggled"),
      contentType: "text/plain",
    });
    expect(await store.verify(artifact.digest)).toMatchObject({ ok: false, detail: expect.stringContaining("extra.txt") });
  });

  it("remove clears the whole prefix, manifest first, and refuses a referenced artifact", async () => {
    const { store, storage } = mockedStore();
    const artifact = await store.put(outputTree(), provenance());

    expect(await store.remove(artifact.digest, async () => true)).toBe(false);
    expect(storage.objects.size).toBe(4);

    storage.calls.length = 0;
    expect(await store.remove(artifact.digest, async () => false)).toBe(true);
    expect(storage.objects.size).toBe(0);
    const deletes = storage.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(2); // the manifest, then the files
    expect(await store.get(artifact.digest)).toBeNull();
    expect(await store.remove(artifact.digest, async () => false)).toBe(false);
  });

  it("does not implement statFile/readFile, so the gateway takes its awaited open() fallback", () => {
    const { store } = mockedStore();
    const asObject = store as unknown as Record<string, unknown>;
    expect(asObject.statFile).toBeUndefined();
    expect(asObject.readFile).toBeUndefined();
  });
});

/* --------------------------------- live suite ------------------------------- */

/**
 * The same three conditions the Postgres contract suite states: the keys say a
 * project exists, and `ZENITH_CONTRACT_POSTGRES=1` says you meant it — because
 * this writes into a **real** bucket. Unset anywhere, the suite skips whole and
 * silent, which is what CI, a fresh clone and a plain `npx vitest run` get.
 */
const live =
  process.env.ZENITH_CONTRACT_POSTGRES === "1" &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Every object this suite writes sits under this, so cleanup deletes its own and nothing else. */
const LIVE_PREFIX = `contract-${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!live)("StorageArtifactStore (live bucket)", () => {
  let store: import("@/lib/hosted/artifacts").StorageArtifactStore;
  let digest = "";
  const body = "console.log('Minimal app OK')";

  beforeAll(async () => {
    store = new artifacts.StorageArtifactStore({
      bucket: process.env.ZENITH_ARTIFACT_BUCKET ?? "zenith-artifacts",
      prefix: LIVE_PREFIX,
    });
  });

  afterAll(async () => {
    if (digest) await store.remove(digest, async () => false);
  });

  it("puts a bundle, reads it back byte for byte, and serves a range", async () => {
    const dir = outputTree({ "assets/index-abc.js": body });
    const artifact = await store.put(dir, provenance());
    digest = artifact.digest;

    expect(artifact.fileCount).toBe(3);
    expect(await store.verify(digest)).toMatchObject({ ok: true });

    const whole = await store.open(digest, "assets/index-abc.js");
    expect(whole?.bytes.toString("utf8")).toBe(body);
    expect(whole?.bytes.length).toBe(whole?.file.bytes);

    const ranged = await store.open(digest, "assets/index-abc.js", { start: 8, end: 11 });
    expect(ranged?.bytes.toString("utf8")).toBe(body.slice(8, 12));
    expect(ranged?.file.bytes).toBe(body.length); // the whole file's size, for content-range

    // Create-only: the same bytes again verify rather than overwrite.
    const again = await store.put(outputTree({ "assets/index-abc.js": body }), provenance());
    expect(again.createdAt).toBe(artifact.createdAt);
  });

  it("removes everything it wrote", async () => {
    expect(await store.remove(digest, async () => false)).toBe(true);
    expect(await store.get(digest)).toBeNull();
    expect(await store.open(digest, "index.html")).toBeNull();
    digest = "";
  });
});
