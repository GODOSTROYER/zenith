import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import type { DataLeg, LegContext, LegEndpoint } from './export-data-leg';
import { knownData, pinnedFixtureImages, rowWitness, type FixtureRow } from './export-data-plan';

// Endpoint schemas are owned and provisioned by the orchestrator; only labelled tables are removed.
function table(ctx: LegContext): string {
  knownData(ctx.runId, ctx.tenant);
  if (!ctx.ownerLabel || ctx.ownerLabel.length > 512) throw new Error('Fixture owner label required');
  return 'zenith_fixture_' + createHash('sha256').update(ctx.ownerLabel).digest('hex').slice(0, 24);
}
async function connect(endpoint: LegEndpoint): Promise<Connection> {
  const url = new URL(endpoint.url), database = decodeURIComponent(url.pathname.slice(1));
  const user = endpoint.user ?? decodeURIComponent(url.username), password = endpoint.password ?? decodeURIComponent(url.password);
  if (url.protocol !== 'mysql:' || !url.hostname || !/^[A-Za-z0-9_]{1,64}$/.test(database) || !user || !password || !endpoint.caFile
    || [...url.searchParams].some(([key, value]) => key !== 'ssl' || value !== 'required')) throw new Error('Owned database, runtime credentials and verified TLS CA required');
  const ca = await readFile(endpoint.caFile);
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
  const name = table(ctx), connection = await connect(ctx.target);
  try {
    if (!await owned(connection, name, ctx.ownerLabel)) throw new Error('Owned target fixture missing');
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT id, tenant, payload, note FROM `' + name + '` ORDER BY id');
    return fixtureRows(rows);
  } finally { await connection.end(); }
}
export const mysqlLeg: DataLeg = {
  kind: 'mysql',
  image: env => pinnedFixtureImages(env).mysql,
  async seedSource(ctx) {
    const name = table(ctx), connection = await connect(ctx.source);
    try {
      if (await owned(connection, name, ctx.ownerLabel)) throw new Error('Source fixture already exists');
      await connection.query('CREATE TABLE `' + name + '` (id VARCHAR(64) NOT NULL, tenant VARCHAR(64) NOT NULL, payload TEXT NOT NULL, note TEXT NULL, PRIMARY KEY (tenant, id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT = ?', [ctx.ownerLabel]);
      await connection.beginTransaction();
      try {
        for (const tenant of ['a', 'b'] as const) for (const row of knownData(ctx.runId, tenant).rows) {
          await connection.execute('INSERT INTO `' + name + '` (id, tenant, payload, note) VALUES (?, ?, ?, ?)', [row.id, row.tenant, row.payload, row.note]);
        }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT id, tenant, payload, note FROM `' + name + '` WHERE tenant = ? ORDER BY id', [ctx.runId + '/' + ctx.tenant]);
      return rowWitness(fixtureRows(rows));
    } finally { await connection.end(); }
  },
  async readTarget(ctx) { return rowWitness(await read(ctx)); },
  async assertNoForeignTenant(ctx) {
    if ((await read(ctx)).some(row => row.tenant !== ctx.runId + '/' + ctx.tenant)) throw new Error('Foreign tenant reached target');
  },
  async cleanup(ctx) {
    const name = table(ctx);
    for (const endpoint of [ctx.source, ctx.target]) {
      const connection = await connect(endpoint);
      try { if (await owned(connection, name, ctx.ownerLabel)) await connection.query('DROP TABLE `' + name + '`'); }
      finally { await connection.end(); }
    }
  },
};
