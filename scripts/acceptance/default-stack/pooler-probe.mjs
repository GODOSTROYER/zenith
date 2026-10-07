// Runs inside the real migration image. Contract tests never pretend this ran.
import postgres from 'postgres';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const url = process.env.SUPABASE_DB_URL;
const parsed = new URL(url);
assert.equal(parsed.hostname, 'supabase-pooler'); assert.equal(parsed.port, '6543');
assert.equal(parsed.search, '?sslmode=verify-full');
const options = { prepare: false, max: 1, connect_timeout: 5, idle_timeout: 1 };
const open = extra => postgres(url, { ...options, ...extra });
const primary = open({});
try {
  const [row] = await primary`select current_database() as database,current_user as role`;
  assert.equal(row.database, 'postgres'); assert.equal(row.role, 'postgres');
  for (const ssl of [{ ca: [], rejectUnauthorized: true }, { ca: fs.readFileSync('/run/zenith-ca.crt'), servername: 'wrong.invalid', rejectUnauthorized: true }]) {
    const negative = open({ ssl });
    try {
      await assert.rejects(negative`select 1`, error => ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code));
    } finally { await negative.end({ timeout: 1 }); }
  }
  if (process.argv[2] === 'concurrency') {
    const schema = `zenith_acceptance_${randomBytes(12).toString('hex')}`;
    const peers = Array.from({ length: 8 }, () => open({}));
    try {
      await primary.unsafe(`create schema ${schema}`);
      await primary.unsafe(`create table ${schema}.counter(id integer primary key,value integer not null); insert into ${schema}.counter values(1,0)`);
      await Promise.all(peers.map(peer => peer.begin(async tx => {
        await tx.unsafe(`update ${schema}.counter set value=value+1 where id=1`);
      })));
      const [result] = await primary.unsafe(`select value from ${schema}.counter where id=1`); assert.equal(result.value, 8);
      process.stdout.write(JSON.stringify({ verifiedTls: true, wrongCaRefused: true, wrongHostnameRefused: true, concurrentTransactions: 8, finalValue: 8 }));
    } finally { await Promise.all(peers.map(peer => peer.end({ timeout: 1 }))); await primary.unsafe(`drop schema if exists ${schema} cascade`); }
  } else process.stdout.write(JSON.stringify({ verifiedTls: true, wrongCaRefused: true, wrongHostnameRefused: true }));
} finally { await primary.end({ timeout: 1 }); }
