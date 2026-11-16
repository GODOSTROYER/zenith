/** Owned PostgreSQL 16 and MinIO fixtures only. NODE_EXTRA_CA_CERTS supplies their CA. */
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPostgres } from "@/lib/portability/connect";
import { S3ObjectStore, parseS3Credentials } from "@/lib/portability/engines/s3";
import { exportPostgres, importPostgres, readbackPostgres } from "@/lib/portability/engines/postgres";
import { exportObjects, importObjects, readbackObjects } from "@/lib/portability/engines/objectstore";
import type { SqlRunner } from "@/lib/portability/types";

const pgUri = process.env.PORTABILITY_DNS_TEST_POSTGRES_URL;
const s3Json = process.env.PORTABILITY_DNS_TEST_S3_CREDENTIALS;
const targetBucket = process.env.PORTABILITY_DNS_TEST_S3_TARGET_BUCKET;
const publicAddress = "93.184.216.34";
afterEach(() => vi.restoreAllMocks());
const readFile = (files: Map<string, Buffer>) => async (name: string) => {
  const bytes = files.get(name); if (!bytes) throw new Error("Owned fixture artifact missing."); return bytes;
};
function sql(binding: Awaited<ReturnType<typeof openPostgres>>): SqlRunner {
  if (binding.binding.kind !== "postgres") throw new Error("Owned fixture kind mismatch.");
  return binding.binding.sql;
}

describe.skipIf(!pgUri)("owned PostgreSQL 16 TLS DNS transport", () => {
  it("exports and imports actual databases with fresh independent readback and original-host TLS", async () => {
    const url = new URL(pgUri!); expect(url.searchParams.get("sslmode")).not.toBe("disable"); expect(net.isIP(url.hostname)).toBe(0);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const options = { allowPrivate: true, lookup }; const connect = vi.spyOn(tls, "connect");
    const admin = await openPostgres(pgUri!, options); const adminSql = sql(admin);
    const names = ["src", "dst"].map((role) => `zenith_dns_${role}_${randomUUID().replace(/-/g, "")}`);
    const created = new Map<string, { oid: unknown; owner: unknown }>();
    const sessions: Awaited<ReturnType<typeof openPostgres>>[] = [];
    try {
      for (const name of names) {
        expect(await adminSql.query("select oid from pg_database where datname=$1", [name])).toEqual([]);
        await adminSql.query(`create database "${name}"`);
        const [identity] = await adminSql.query("select oid::text as oid,datdba::text as owner from pg_database where datname=$1", [name]);
        if (!identity) throw new Error("Owned database identity missing.");
        created.set(name, { oid: identity.oid, owner: identity.owner });
      }
      const dbUri = (name: string) => { const copy = new URL(pgUri!); copy.pathname = `/${name}`; return copy.toString(); };
      const source = await openPostgres(dbUri(names[0]!), options); sessions.push(source);
      await sql(source).query("create table records (id integer primary key, payload jsonb, note text)");
      await sql(source).query("insert into records values (1, $1::text::jsonb, $2)", [JSON.stringify({ nested: [1, null, "☃"] }), "line\nquote"]);
      expect(await sql(source).query("select payload,note from records")).toEqual([{ payload: { nested: [1, null, "☃"] }, note: "line\nquote" }]);
      const files = new Map<string, Buffer>(); const exported = await exportPostgres(sql(source), async (name, bytes) => { files.set(name, bytes); });
      expect(exported.engineVersion).toMatch(/^16\./);
      const target = await openPostgres(dbUri(names[1]!), options); sessions.push(target);
      expect(await importPostgres(sql(target), readFile(files))).toMatchObject({ tables: 1, rows: 1 });
      const readback = await openPostgres(dbUri(names[1]!), options); sessions.push(readback);
      expect((await readbackPostgres(sql(readback))).contentDigest).toBe(exported.contentDigest);
      expect(await sql(readback).query("select payload,note from records")).toEqual([{ payload: { nested: [1, null, "☃"] }, note: "line\nquote" }]);
      for (const call of connect.mock.calls) expect(call[0]).toMatchObject({ servername: url.hostname, rejectUnauthorized: true });
      expect(connect.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      try {
        for (const [name, identity] of created) {
          const rows = await adminSql.query("select oid::text as oid,datdba::text as owner from pg_database where datname=$1", [name]);
          if (rows.length !== 1 || rows[0]!.oid !== identity.oid || rows[0]!.owner !== identity.owner) throw new Error("Owned fixture custody changed; refusing cleanup.");
          await adminSql.query(`drop database "${name}"`);
          expect(await adminSql.query("select oid from pg_database where datname=$1", [name])).toEqual([]);
        }
      } finally { await admin.close(); }
    }
  });

  it("refuses rebinding after public preflight before any connection to the actual engine", async () => {
    const connect = vi.spyOn(net, "createConnection");
    const lookup = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(["127.0.0.1"]);
    const binding = await openPostgres(pgUri!, { allowPrivate: false, lookup });
    try { await expect(sql(binding).query("select 1")).rejects.toMatchObject({ code: "invalid_input" }); }
    finally { await binding.close(); }
    expect(connect).not.toHaveBeenCalled(); expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("revalidates after the actual engine closes an owned session", async () => {
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]); const options = { allowPrivate: true, lookup };
    const admin = await openPostgres(pgUri!, options); const binding = await openPostgres(pgUri!, options);
    const connect = vi.spyOn(net, "createConnection");
    try {
      const [row] = await sql(binding).query("select pg_backend_pid() as pid");
      expect(typeof row?.pid).toBe("number");
      await sql(admin).query("select pg_terminate_backend($1)", [row!.pid]);
      lookup.mockResolvedValue(["::ffff:a9fe:a9fe"]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await expect(sql(binding).query("select 1")).rejects.toMatchObject({ code: "invalid_input" });
      expect(connect).toHaveBeenCalledTimes(2); // first owned session plus admin session
    } finally { await binding.close(); await admin.close(); }
  });
});

describe.skipIf(!s3Json || !targetBucket)("owned MinIO TLS DNS transport", () => {
  it("exports actual MinIO bytes and imports them with a fresh independent production-adapter readback", async () => {
    const creds = parseS3Credentials(s3Json!); const endpoint = new URL(creds.endpoint!);
    expect(endpoint.protocol).toBe("https:"); expect(net.isIP(endpoint.hostname)).toBe(0);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]); const options = { allowPrivate: true, lookup }; const connect = vi.spyOn(tls, "connect");
    const source = new S3ObjectStore(creds, options); const target = new S3ObjectStore({ ...creds, bucket: targetBucket! }, options);
    await source.put("text.txt", Buffer.from("unicode ☃\n"), "text/plain");
    await source.put("dir/binary.bin", Buffer.from([0, 1, 255]), "application/octet-stream");
    const files = new Map<string, Buffer>(); const exported = await exportObjects(source, async (name, bytes) => { files.set(name, bytes); });
    expect(await importObjects(target, readFile(files))).toMatchObject({ objects: 2 });
    const fresh = new S3ObjectStore({ ...creds, bucket: targetBucket! }, options);
    expect((await readbackObjects(fresh)).contentDigest).toBe(exported.contentDigest);
    expect(await fresh.get("text.txt")).toEqual({ bytes: Buffer.from("unicode ☃\n"), contentType: "text/plain" });
    for (const call of connect.mock.calls) expect(call[0]).toMatchObject({ host: "127.0.0.1", servername: endpoint.hostname, rejectUnauthorized: true });
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("refuses rebinding after public preflight without connecting to actual MinIO", async () => {
    const connect = vi.spyOn(tls, "connect"); const lookup = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(["127.0.0.1"]);
    const store = new S3ObjectStore(parseS3Credentials(s3Json!), { allowPrivate: false, lookup });
    await expect(store.put("refused.txt", Buffer.from("fixture"))).rejects.toMatchObject({ code: "invalid_input" });
    expect(connect).not.toHaveBeenCalled(); expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("revalidates a retry after a real MinIO TLS connection closes", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValue(["::ffff:a9fe:a9fe"]);
    const connect = tls.connect.bind(tls);
    const spy = vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) => {
      const socket = connect(options);
      // Let the Agent deliver the secured socket to ClientRequest before injecting
      // its transport fault; ClientRequest then owns the ordinary error lifecycle.
      socket.once("secureConnect", () => setImmediate(() => socket.destroy(Object.assign(new Error("Owned fixture transport reset."), { code: "ECONNRESET" }))));
      return socket;
    }) as typeof tls.connect);
    const store = new S3ObjectStore(parseS3Credentials(s3Json!), { allowPrivate: true, lookup });
    await expect(store.put("retry-refused.txt", Buffer.from("fixture"))).rejects.toMatchObject({ code: "invalid_input" });
    expect(spy).toHaveBeenCalledTimes(1); expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
