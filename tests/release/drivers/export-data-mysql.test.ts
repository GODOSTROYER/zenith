import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mysqlLeg } from '../../../scripts/release/drivers/export-data-mysql';
import { knownData, rowWitness } from '../../../scripts/release/drivers/export-data-plan';
import type { LegContext } from '../../../scripts/release/drivers/export-data-leg';
const fake = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), identity: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createConnection: fake.create }));
vi.mock('node:fs/promises', () => ({ readFile: fake.read }));
vi.mock('node:tls', () => ({ checkServerIdentity: fake.identity }));
const ctx: LegContext = { runId: 'mysql-test', tenant: 'a', ownerLabel: 'owned-test',
  source: { url: 'mysql://source.test/fixture', user: 'fixture', password: randomBytes(24).toString('hex'), caFile: 'private-ca' },
  target: { url: 'mysql://target.test/fixture', user: 'fixture', password: randomBytes(24).toString('hex'), caFile: 'private-ca' } };
function connection(owner: string | null = ctx.ownerLabel, rows = knownData(ctx.runId, ctx.tenant).rows) {
  return { connection: { stream: { encrypted: true, authorized: true, getPeerCertificate: vi.fn(() => ({})) } },
    execute: vi.fn(async (sql: string) => [sql.includes('information_schema') ? owner === null ? [] : [{ owner }] : sql.startsWith('SELECT') ? rows : [], []]),
    query: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(), destroy: vi.fn() };
}
beforeEach(() => { vi.resetAllMocks(); fake.read.mockResolvedValue(Buffer.from('fake-ca')); });
describe('MySQL data leg offline contracts', () => {
  it('seeds both tenants with bound values and witnesses actual source readback', async () => {
    const c = connection(null); fake.create.mockResolvedValue(c);
    expect(await mysqlLeg.seedSource(ctx)).toEqual(rowWitness(knownData(ctx.runId, 'a').rows));
    const inserts = c.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(6);
    expect(inserts.map(call => (call as unknown as [string, unknown[]])[1])).toEqual(['a', 'b'].flatMap(t => knownData(ctx.runId, t as 'a' | 'b').rows.map(r => [r.id, r.tenant, r.payload, r.note])));
    expect(c.query.mock.calls[0][1]).toEqual([ctx.ownerLabel]);
    expect(c.commit).toHaveBeenCalledOnce(); expect(c.end).toHaveBeenCalledOnce();
    expect(fake.create.mock.calls[0][0]).toMatchObject({ host: 'source.test', ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' }, multipleStatements: false });
  });
  it('reads all target rows ordered by id and rejects foreign tenants', async () => {
    const c = connection(); fake.create.mockResolvedValue(c);
    expect(await mysqlLeg.readTarget(ctx)).toEqual(rowWitness(knownData(ctx.runId, 'a').rows));
    await mysqlLeg.assertNoForeignTenant(ctx);
    expect(c.execute.mock.calls.some(([sql]) => sql.endsWith('ORDER BY id') && !sql.includes('WHERE tenant'))).toBe(true);
    fake.create.mockResolvedValue(connection(ctx.ownerLabel, knownData(ctx.runId, 'b').rows));
    await expect(mysqlLeg.assertNoForeignTenant(ctx)).rejects.toThrow('Foreign tenant');
  });
  it.each(['plaintext', 'unauthorized', 'identity'])('refuses %s before SQL', async mode => {
    const c = connection(); fake.create.mockResolvedValue(c);
    if (mode === 'plaintext') c.connection.stream.encrypted = false;
    if (mode === 'unauthorized') c.connection.stream.authorized = false;
    if (mode === 'identity') fake.identity.mockReturnValue(new Error('bad identity'));
    await expect(mysqlLeg.readTarget(ctx)).rejects.toThrow('Verified TLS');
    expect(c.execute).not.toHaveBeenCalled(); expect(c.destroy).toHaveBeenCalledOnce();
  });
  it.each([{ ...ctx.source, caFile: undefined }, { ...ctx.source, url: ctx.source.url + '?ssl=disabled' }, { ...ctx.source, password: '' }])('refuses insecure endpoint before connecting', async source => {
    await expect(mysqlLeg.seedSource({ ...ctx, source })).rejects.toThrow(); expect(fake.create).not.toHaveBeenCalled();
  });
  it('cleans only labelled tables and is idempotent for absent tables', async () => {
    const c = connection(); fake.create.mockResolvedValue(c); await mysqlLeg.cleanup(ctx);
    expect(c.query).toHaveBeenCalledTimes(2); expect(c.query.mock.calls.every(([sql]) => sql.startsWith('DROP TABLE'))).toBe(true);
    const absent = connection(null); fake.create.mockResolvedValue(absent); await mysqlLeg.cleanup(ctx); expect(absent.query).not.toHaveBeenCalled();
    const foreign = connection('somebody-else'); fake.create.mockResolvedValue(foreign);
    await expect(mysqlLeg.cleanup(ctx)).rejects.toThrow('unowned'); expect(foreign.query).not.toHaveBeenCalled(); expect(foreign.end).toHaveBeenCalledOnce();
  });
  it('rolls back failed inserts and closes connections', async () => {
    const c = connection(null); c.execute.mockImplementation(async sql => { if (sql.startsWith('INSERT')) throw new Error('insert failed'); return [[], []]; }); fake.create.mockResolvedValue(c);
    await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('insert failed'); expect(c.rollback).toHaveBeenCalledOnce(); expect(c.commit).not.toHaveBeenCalled(); expect(c.end).toHaveBeenCalledOnce();
  });
  it('refuses overwriting existing owned source tables', async () => {
    const c = connection(); fake.create.mockResolvedValue(c); await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('already exists'); expect(c.query).not.toHaveBeenCalled();
  });
  it('requires digest pinned fixture images', () => {
    expect(() => mysqlLeg.image({})).toThrow();
    const image = 'mysql:8.4@sha256:' + 'a'.repeat(64);
    expect(mysqlLeg.image({ ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: image, ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE: image, ZENITH_LOCAL_EXPORT_MINIO_IMAGE: image })).toBe(image);
  });
});
