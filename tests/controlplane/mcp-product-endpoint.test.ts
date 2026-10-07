import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mcpProductEndpoint } from '@/lib/controlplane/db/repos/mcp-product-endpoint';
const ref = 'abcdefghijklmnopqrst';
const database = (host: string, user = `postgres.${ref}`) => new URL(`postgresql://${user}:${randomBytes(32).toString('hex')}@${host}:6543/postgres?sslmode=verify-full`);
describe('MCP project and database endpoint admission', () => {
  it('admits an exact twenty-character hosted project and its matching pooler realm', () => {
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database('aws-0-unit.pooler.supabase.com'))).toBe(true);
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database(`db.${ref}.supabase.co`, 'postgres'))).toBe(true);
  });
  it.each([ref.slice(1), ref + 'u'])('does not relax hosted project reference validation for %s', wrong => {
    expect(mcpProductEndpoint(new URL(`https://${wrong}.supabase.co`), database('aws-0-unit.pooler.supabase.com', `postgres.${wrong}`))).toBe(false);
  });
  it('admits the exact local CLI TLS pooler endpoint without impersonating a hosted project', () => {
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), database('supabase-pooler', 'postgres.pooler-dev'))).toBe(true);
  });
  it.each(['https://supabase.localhost:54322', 'http://supabase.localhost:54321', 'https://foreign.localhost:54321', 'https://supabase.localhost:54321/path'])('refuses an unbound local origin %s', origin => {
    expect(mcpProductEndpoint(new URL(origin), database('supabase-pooler', 'postgres.pooler-dev'))).toBe(false);
  });
  it('refuses mismatched project realms and a separate platform database', () => {
    expect(mcpProductEndpoint(new URL(`https://${ref}.supabase.co`), database('aws-0-unit.pooler.supabase.com', 'postgres.uvwxyzabcdefghijklmn'))).toBe(false);
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), database('platform-db', 'postgres'))).toBe(false);
  });
  it.each(['sslmode=require', 'sslmode=verify-full&sslmode=require', 'ssl=false', ''])('refuses weaker or ambiguous local TLS: %s', query => {
    const value = database('supabase-pooler', 'postgres.pooler-dev'); value.search = query;
    expect(mcpProductEndpoint(new URL('https://supabase.localhost:54321'), value)).toBe(false);
  });
});
