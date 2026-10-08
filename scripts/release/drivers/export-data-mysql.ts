import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import type { DataLeg, LegContext, LegEndpoint } from './export-data-leg';
import { assertEqualContent, knownData, pinnedFixtureImages, rowWitness, type FixtureRow } from './export-data-plan';

// Endpoint schemas are owned and provisioned by the orchestrator; only labelled tables are removed.
function table(ctx: LegContext): string {
  knownData(ctx.runId, ctx.tenant);
  if (!ctx.ownerLabel || ctx.ownerLabel.length > 512) throw new Error('Fixture owner label required');
  return 'zenith_fixture_' + createHash('sha256').update(ctx.ownerLabel).digest('hex').slice(0, 24);
}
function validateEndpoint(endpoint: LegEndpoint) {
  const url = new URL(endpoint.url), database = decodeURIComponent(url.pathname.slice(1));
  const user = endpoint.user ?? decodeURIComponent(url.username), password = endpoint.password ?? decodeURIComponent(url.password);
  if (url.protocol !== 'mysql:' || !url.hostname || !/^[A-Za-z0-9_]{1,64}$/.test(database) || !user || !password || !endpoint.caFile
    || [...url.searchParams].some(([key, value]) => key !== 'ssl' || value !== 'required')) throw new Error('Owned database, runtime credentials and verified TLS CA required');
  return { url, database, user, password, caFile: endpoint.caFile };
}
async function connect(endpoint: LegEndpoint): Promise<Connection> {
  const { url, database, user, password, caFile } = validateEndpoint(endpoint);
  const ca = await readFile(caFile);
  if (!ca.length) throw new Error('Empty private CA');
  const connection = await createConnection({ host: url.hostname, port: Number(url.port || 3306), database, user, password,
    charset: 'UTF8MB4_UNICODE_CI', multipleStatements: false, flags: ['-LOCAL_FILES'], connectTimeout: 20_000,
    ssl: { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } });
  const stream = (connection as unknown as { connection: { stream: TLSSocket } }).connection.stream;
  try {
    if (!stream?.encrypted || stream.authorized !== true || typeof stream.getPeerCertificate !== 'function'
      || checkServerIdentity(url.hostname, stream.getPeerCertificate(true))) throw new Error('Verified TLS identity required');
    return connection;
  } catch (error) { connection.destroy(); throw error; }
}
function tenantEndpoint(endpoint: LegEndpoint, tenant: 'a' | 'b'): LegEndpoint {
  const url = new URL(endpoint.url);
  url.pathname = '/tenant_' + tenant;
  return { ...endpoint, url: url.toString() };
}
async function inventory(connection: Connection): Promise<RowDataPacket[]> {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT TABLE_NAME AS name, TABLE_COMMENT AS owner FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  return rows;
}
async function owned(connection: Connection, name: string, label: string): Promise<boolean> {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT TABLE_COMMENT AS owner FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  if (!rows.length) return false;
  if (rows.length !== 1 || rows[0].owner !== label) throw new Error('Refusing unowned fixture table');
  return true;
}
function fixtureRows(rows: RowDataPacket[]): FixtureRow[] {
  return rows.map(row => ({ id: row.id, tenant: row.tenant, payload: row.payload, note: row.note }));
}
async function read(ctx: LegContext): Promise<FixtureRow[]> {
  const name = table(ctx), connection = await connect(tenantEndpoint(ctx.target, ctx.tenant));
  try {
    const tables = await inventory(connection);
    if (!tables.length) return [];
    if (tables.length !== 1 || tables[0].name !== name || tables[0].owner !== ctx.ownerLabel) throw new Error('Unexpected or unowned MySQL fixture table');
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT id, tenant, payload, note FROM `' + name + '` ORDER BY id');
    return fixtureRows(rows);
  } finally { await connection.end(); }
}
export const mysqlLeg: DataLeg = {
  kind: 'mysql',
  image: env => pinnedFixtureImages(env).mysql,
  async seedSource(ctx) {
    const name = table(ctx);
    validateEndpoint(tenantEndpoint(ctx.source, ctx.tenant));
    validateEndpoint(tenantEndpoint(ctx.target, ctx.tenant));
    for (const tenant of ['a', 'b'] as const) {
      const target = await connect(tenantEndpoint(ctx.target, tenant));
      try { if ((await inventory(target)).length) throw new Error('MySQL target must be empty'); }
      finally { await target.end(); }
    }
    for (const tenant of ['a', 'b'] as const) {
      const connection = await connect(tenantEndpoint(ctx.source, tenant));
      try {
        if ((await inventory(connection)).length) throw new Error('Source fixture already exists');
        await connection.query('CREATE TABLE `' + name + '` (id VARCHAR(64) NOT NULL, tenant VARCHAR(64) NOT NULL, payload TEXT NOT NULL, note TEXT NULL, PRIMARY KEY (tenant, id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT = ?', [ctx.ownerLabel]);
        await connection.beginTransaction();
        try {
          for (const row of knownData(ctx.runId, tenant).rows) {
            await connection.execute('INSERT INTO `' + name + '` (id, tenant, payload, note) VALUES (?, ?, ?, ?)', [row.id, row.tenant, row.payload, row.note]);
          }
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
      } finally { await connection.end(); }
      // Reopen the selected database; a filtered read must never hide foreign data.
      assertEqualContent(rowWitness(knownData(ctx.runId, tenant).rows), rowWitness(await read({ ...ctx, tenant, target: ctx.source })));
    }
    for (const tenant of ['a', 'b'] as const) if ((await read({ ...ctx, tenant })).length) throw new Error('MySQL target must be empty');
    return rowWitness(await read({ ...ctx, target: ctx.source }));
  },
  async readTarget(ctx) { return rowWitness(await read(ctx)); },
  async assertNoForeignTenant(ctx) {
    if ((await read(ctx)).some(row => row.tenant !== ctx.runId + '/' + ctx.tenant)) throw new Error('Foreign tenant reached target');
    const other = ctx.tenant === 'a' ? 'b' : 'a';
    if ((await read({ ...ctx, tenant: other })).length) throw new Error('Foreign MySQL target database changed');
  },
  async cleanup(ctx) {
    const name = table(ctx);
    let failed = false;
    for (const endpoint of [ctx.source, ctx.target]) for (const tenant of ['a', 'b'] as const) {
      try {
        const connection = await connect(tenantEndpoint(endpoint, tenant));
        try {
          if (await owned(connection, name, ctx.ownerLabel)) {
            await connection.query('DROP TABLE `' + name + '`');
            if (await owned(connection, name, ctx.ownerLabel)) throw new Error('MySQL table cleanup unconfirmed');
          }
        } finally { await connection.end(); }
      } catch { failed = true; }
    }
    if (failed) throw new Error('MySQL owned cleanup failed');
  },
};
