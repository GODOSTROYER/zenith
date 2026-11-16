import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mysqlLeg } from '../../../scripts/release/drivers/export-data-mysql';
import { knownData, rowWitness, type FixtureRow } from '../../../scripts/release/drivers/export-data-plan';
import type { LegContext } from '../../../scripts/release/drivers/export-data-leg';
const fake = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), identity: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createConnection: fake.create }));
vi.mock('node:fs/promises', () => ({ readFile: fake.read }));
vi.mock('node:tls', () => ({ checkServerIdentity: fake.identity }));
const ctx: LegContext = { runId: 'mysql-test', tenant: 'a', ownerLabel: 'DRV4-DATA:mysql-test',
  source: { url: 'mysql://source.test:3306/mysql', user: 'fixture', password: randomBytes(24).toString('hex'), caFile: 'private-ca' },
  target: { url: 'mysql://target.test:3306/mysql', user: 'fixture', password: randomBytes(24).toString('hex'), caFile: 'private-ca' } };
type Table = { name: string; owner: string; rows: FixtureRow[] };
let databases: Map<string, Table[]>;
function connection(key: string) {
  const tables = () => databases.get(key)!;
  return { connection: { stream: { encrypted: true, authorized: true, getPeerCertificate: vi.fn(() => ({})) } },
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('information_schema')) return [sql.includes('TABLE_NAME = ?')
        ? tables().filter(t => t.name === params[0]).map(t => ({ owner: t.owner }))
        : tables().map(t => ({ name: t.name, owner: t.owner })), []];
      if (sql.startsWith('INSERT')) tables()[0].rows.push({ id: params[0] as string, tenant: params[1] as string, payload: params[2] as string, note: params[3] as string | null });
      return [sql.startsWith('SELECT') ? tables()[0].rows.map(r => ({ ...r })) : [], []];
    }),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('CREATE TABLE')) tables().push({ name: sql.match(/`([^`]+)`/)![1], owner: params[0] as string, rows: [] });
      if (sql.startsWith('DROP TABLE')) databases.set(key, tables().filter(t => t.name !== sql.match(/`([^`]+)`/)![1]));
    }),
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), end: vi.fn(), destroy: vi.fn() };
}
let sessions: ReturnType<typeof connection>[];
beforeEach(() => {
  vi.resetAllMocks(); fake.read.mockResolvedValue(Buffer.from('fake-ca'));
  databases = new Map(['source.test', 'target.test'].flatMap(host => ['a', 'b'].map(t => [`${host}/tenant_${t}`, [] as Table[]] as const)));
  sessions = [];
  fake.create.mockImplementation(async (config: { host: string; database: string }) => {
    const c = connection(`${config.host}/${config.database}`); sessions.push(c); return c;
  });
});
function restoreA() { databases.set('target.test/tenant_a', structuredClone(databases.get('source.test/tenant_a')!)); }

describe('MySQL data leg offline contracts', () => {
  it('seeds each tenant in its own whole-export database with bound values and independent source readback', async () => {
    expect(await mysqlLeg.seedSource(ctx)).toEqual(rowWitness(knownData(ctx.runId, 'a').rows));
    for (const tenant of ['a', 'b'] as const) {
      expect(databases.get(`source.test/tenant_${tenant}`)![0].rows).toEqual(knownData(ctx.runId, tenant).rows);
      expect(databases.get(`source.test/tenant_${tenant}`)![0].owner).toBe(ctx.ownerLabel);
      expect(databases.get(`target.test/tenant_${tenant}`)).toEqual([]);
    }
    const inserts = sessions.flatMap(c => c.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT')));
    expect(inserts).toHaveLength(6);
    expect(inserts.map(([, params]) => params)).toEqual(['a', 'b'].flatMap(t => knownData(ctx.runId, t as 'a' | 'b').rows.map(r => [r.id, r.tenant, r.payload, r.note])));
    expect(sessions.filter(c => c.commit.mock.calls.length)).toHaveLength(2);
    expect(sessions.every(c => c.end.mock.calls.length === 1)).toBe(true);
    expect(fake.create.mock.calls.every(([config]) => ['tenant_a', 'tenant_b'].includes(config.database))).toBe(true);
    expect(fake.create.mock.calls.find(([config]) => config.host === 'source.test')![0]).toMatchObject({ host: 'source.test', database: 'tenant_a', ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' }, multipleStatements: false });
    expect(sessions.flatMap(c => c.execute.mock.calls).some(([sql]) => sql.includes('WHERE tenant'))).toBe(false);
  });
  it('reads a fresh empty target, reads the complete restored database, and rejects foreign selected or other-target content', async () => {
    expect(await mysqlLeg.readTarget(ctx)).toEqual(rowWitness([]));
    await mysqlLeg.seedSource(ctx); restoreA();
    expect(await mysqlLeg.readTarget(ctx)).toEqual(rowWitness(knownData(ctx.runId, 'a').rows));
    await mysqlLeg.assertNoForeignTenant(ctx);
    expect(sessions.flatMap(c => c.execute.mock.calls).some(([sql]) => sql.endsWith('ORDER BY id') && !sql.includes('WHERE tenant'))).toBe(true);
    databases.get('target.test/tenant_a')![0].rows = knownData(ctx.runId, 'b').rows;
    await expect(mysqlLeg.assertNoForeignTenant(ctx)).rejects.toThrow('Foreign tenant');
    restoreA(); databases.set('target.test/tenant_b', structuredClone(databases.get('source.test/tenant_b')!));
    await expect(mysqlLeg.assertNoForeignTenant(ctx)).rejects.toThrow('Foreign MySQL target');
  });
  it.each(['plaintext', 'unauthorized', 'identity'])('refuses %s before SQL', async mode => {
    const c = connection('target.test/tenant_a'); fake.create.mockResolvedValue(c);
    if (mode === 'plaintext') c.connection.stream.encrypted = false;
    if (mode === 'unauthorized') c.connection.stream.authorized = false;
    if (mode === 'identity') fake.identity.mockReturnValue(new Error('bad identity'));
    await expect(mysqlLeg.readTarget(ctx)).rejects.toThrow('Verified TLS');
    expect(c.execute).not.toHaveBeenCalled(); expect(c.destroy).toHaveBeenCalledOnce();
  });
  it.each([{ ...ctx.source, caFile: undefined }, { ...ctx.source, url: ctx.source.url + '?ssl=disabled' }, { ...ctx.source, password: '' }])('refuses insecure endpoint before connecting', async source => {
    await expect(mysqlLeg.seedSource({ ...ctx, source })).rejects.toThrow(); expect(fake.create).not.toHaveBeenCalled();
  });
  it('cleans all four labelled tenant units, is idempotent, and refuses an unowned table while continuing other cleanup', async () => {
    await mysqlLeg.seedSource(ctx); restoreA();
    await mysqlLeg.cleanup(ctx); expect([...databases.values()].every(t => t.length === 0)).toBe(true);
    const before = sessions.flatMap(c => c.query.mock.calls).filter(([sql]) => sql.startsWith('DROP TABLE')).length;
    expect(before).toBe(3);
    await mysqlLeg.cleanup(ctx);
    expect(sessions.flatMap(c => c.query.mock.calls).filter(([sql]) => sql.startsWith('DROP TABLE'))).toHaveLength(before);
    await mysqlLeg.seedSource(ctx); restoreA();
    databases.get('source.test/tenant_a')![0].owner = 'somebody-else';
    await expect(mysqlLeg.cleanup(ctx)).rejects.toThrow('owned cleanup');
    expect(databases.get('source.test/tenant_a')).toHaveLength(1);
    for (const key of ['source.test/tenant_b', 'target.test/tenant_a', 'target.test/tenant_b']) expect(databases.get(key)).toEqual([]);
    expect(sessions.every(c => c.end.mock.calls.length === 1)).toBe(true);
  });
  it('rolls back failed inserts and closes connections', async () => {
    const c = connection('source.test/tenant_a'); c.execute.mockImplementation(async sql => { if (sql.startsWith('INSERT')) throw new Error('insert failed'); return [[], []]; });
    const create = fake.create.getMockImplementation()!;
    fake.create.mockImplementation(async config => config.host === 'source.test' ? c : create(config));
    await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('insert failed'); expect(c.rollback).toHaveBeenCalledOnce(); expect(c.commit).not.toHaveBeenCalled(); expect(c.end).toHaveBeenCalledOnce();
  });
  it('refuses overwriting existing owned source tables and unexpected target inventories', async () => {
    await mysqlLeg.seedSource(ctx);
    const creates = sessions.flatMap(c => c.query.mock.calls).filter(([sql]) => sql.startsWith('CREATE TABLE')).length;
    await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('already exists');
    expect(sessions.flatMap(c => c.query.mock.calls).filter(([sql]) => sql.startsWith('CREATE TABLE'))).toHaveLength(creates);
    databases.set('target.test/tenant_a', [{ name: 'unexpected', owner: ctx.ownerLabel, rows: [] }]);
    await expect(mysqlLeg.readTarget(ctx)).rejects.toThrow('Unexpected or unowned');
  });
  it('refuses a prepopulated target before any source mutation and rejects a corrupt independent source read', async () => {
    databases.set('target.test/tenant_b', [{ name: 'existing', owner: ctx.ownerLabel, rows: [] }]);
    await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('target must be empty');
    expect(databases.get('source.test/tenant_a')).toEqual([]);
    databases.set('target.test/tenant_b', []);
    const create = fake.create.getMockImplementation()!;
    fake.create.mockImplementation(async config => {
      const c = await create(config);
      if (config.host === 'source.test') {
        const execute = c.execute.getMockImplementation()!;
        c.execute.mockImplementation(async (sql: string, params: unknown[] = []) => sql.startsWith('SELECT id,') ? [knownData(ctx.runId, 'b').rows, []] : execute(sql, params));
      }
      return c;
    });
    await expect(mysqlLeg.seedSource(ctx)).rejects.toThrow('Independent content readback mismatch');
  });
  it('requires digest pinned fixture images', () => {
    expect(() => mysqlLeg.image({})).toThrow();
    const image = 'mysql:8.4@sha256:' + 'a'.repeat(64);
    expect(mysqlLeg.image({ ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: image, ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE: image, ZENITH_LOCAL_EXPORT_MINIO_IMAGE: image })).toBe(image);
  });
});
