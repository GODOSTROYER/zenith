import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCompose, composeArgs, composeEnvironment, planFor, prepare, prepareJoin, probeReadiness, readPrepared, validateInput } from '../../scripts/deploy/installation.mjs';

type Input = Parameters<typeof prepare>[0];
type Prepared = ReturnType<typeof prepare>;
const repository = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenith-installation-'));
const privateDir = path.join(temp, 'production');
const fixtureDir = path.join(temp, 'disposable');
const runtimeSecret = () => randomBytes(32).toString('hex');
const image = (name: string) => `zenith-unit/${name}@sha256:${runtimeSecret()}`;
function input(mode: Input['mode'] = 'production'): Input {
  return {
    mode, apiPort: 36400, images: { api: image('api'), worker: image('worker'), migration: image('migration') },
    environment: {
      NEXT_PUBLIC_SITE_URL: mode === 'production' ? 'https://zenith.unit.invalid' : 'http://127.0.0.1:36400',
      SUPABASE_URL: 'https://supabase.unit.invalid', NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.unit.invalid',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtimeSecret(), SUPABASE_SERVICE_ROLE_KEY: runtimeSecret(),
      SUPABASE_DB_URL: `postgresql://operator:${runtimeSecret()}@pooler.unit.invalid:6543/product?sslmode=verify-full`,
      ...(mode === 'production' ? {
        ZENITH_PLATFORM_DB_URL: `postgresql://application:${runtimeSecret()}@platform.unit.invalid:5432/platform?sslmode=verify-full`,
        ZENITH_PLATFORM_MIGRATION_URL: `postgresql://migration:${runtimeSecret()}@platform.unit.invalid:5432/platform?sslmode=verify-full`,
        ZENITH_TEMPORAL_ADDRESS: 'temporal.unit.invalid:7233', ZENITH_TEMPORAL_NAMESPACE: 'zenith-unit',
        ZENITH_TEMPORAL_TLS: 'true', ZENITH_TEMPORAL_API_KEY: runtimeSecret(),
      } : {}),
    },
  };
}
let production: Prepared;
let disposable: Prepared;
beforeAll(() => { production = prepare(input(), privateDir); disposable = prepare(input('disposable'), fixtureDir); });
afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

describe('supported installation structural preflight', () => {
  it('requires actual durable product, separate platform and authenticated Temporal inputs', () => {
    expect(validateInput(input()).mode).toBe('production');
  });
  const badInputs: { id: string; change: (value: Input) => void; failure: string }[] = [
    { id: 'public auth absent', change: v => { delete v.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; }, failure: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' },
    { id: 'service auth absent', change: v => { delete v.environment.SUPABASE_SERVICE_ROLE_KEY; }, failure: 'SUPABASE_SERVICE_ROLE_KEY' },
    { id: 'public auth mismatch', change: v => { v.environment.NEXT_PUBLIC_SUPABASE_URL = 'https://other.unit.invalid'; }, failure: 'NEXT_PUBLIC_SUPABASE_URL' },
    { id: 'placeholder', change: v => { v.environment.SUPABASE_SERVICE_ROLE_KEY = '<replace me>'; }, failure: 'SUPABASE_SERVICE_ROLE_KEY' },
    { id: 'non-TLS public origin', change: v => { v.environment.NEXT_PUBLIC_SITE_URL = 'http://127.0.0.1:36400'; }, failure: 'NEXT_PUBLIC_SITE_URL' },
    { id: 'nonverifying pooler TLS', change: v => { v.environment.SUPABASE_DB_URL = v.environment.SUPABASE_DB_URL.replace('verify-full', 'require'); }, failure: 'SUPABASE_DB_URL' },
    { id: 'wrong pooler mode', change: v => { v.environment.SUPABASE_DB_URL = v.environment.SUPABASE_DB_URL.replace('6543', '5432'); }, failure: 'transaction-pooler' },
    { id: 'TLS override parameter', change: v => { v.environment.SUPABASE_DB_URL += '&ssl=false'; }, failure: 'SUPABASE_DB_URL' },
    { id: 'nonverifying platform TLS', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = v.environment.ZENITH_PLATFORM_DB_URL.replace('verify-full', 'require'); }, failure: 'ZENITH_PLATFORM_DB_URL' },
    { id: 'shared database authority', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = v.environment.SUPABASE_DB_URL; v.environment.ZENITH_PLATFORM_MIGRATION_URL = v.environment.SUPABASE_DB_URL; }, failure: 'separate-platform-authority' },
    { id: 'different migration authority', change: v => { v.environment.ZENITH_PLATFORM_MIGRATION_URL = v.environment.ZENITH_PLATFORM_MIGRATION_URL.replace('/platform?', '/other?'); }, failure: 'platform-migration-authority' },
    { id: 'file backend override', change: v => { v.environment.ZENITH_STORE = 'file'; }, failure: 'unknown-environment-field' },
    { id: 'PGlite platform', change: v => { v.environment.ZENITH_PLATFORM_DB_URL = 'file:///private/platform'; }, failure: 'ZENITH_PLATFORM_DB_URL' },
    { id: 'Temporal auth absent', change: v => { delete v.environment.ZENITH_TEMPORAL_API_KEY; }, failure: 'ZENITH_TEMPORAL_API_KEY' },
    { id: 'Temporal TLS disabled', change: v => { v.environment.ZENITH_TEMPORAL_TLS = 'false'; }, failure: 'ZENITH_TEMPORAL_TLS' },
    { id: 'unpaired OAuth config', change: v => { v.environment.ZENITH_AGENT_OAUTH_ISSUER = 'https://oauth.unit.invalid'; }, failure: 'ZENITH_AGENT_OAUTH_JWKS' },
    { id: 'floating image', change: v => { v.images.worker = 'zenith/worker:latest'; }, failure: 'images.worker' },
    { id: 'out-of-range port', change: v => { v.apiPort = 80; }, failure: 'apiPort' },
  ];
  it.each(badInputs)('rejects $id without exposing values', ({ change, failure }) => {
    const value = input(); change(value);
    expect(() => validateInput(value)).toThrow(failure);
    try { validateInput(value); } catch (error) {
      expect(String(error)).not.toContain(value.environment.SUPABASE_DB_URL);
      expect(String(error)).not.toContain(value.environment.SUPABASE_SERVICE_ROLE_KEY ?? runtimeSecret());
    }
  });
  const databaseTlsCases = ['SUPABASE_DB_URL', 'ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_MIGRATION_URL'].flatMap(field => [
    'sslmode=verify-full&sslmode=require',
    'sslmode=require&sslmode=verify-full',
    'sslmode=verify-full&sslmode=verify-full',
    'sslmode=verify-full&%73slmode=require',
    '%73slmode=require&sslmode=verify-full',
    'sslmode=require',
    'sslmode=prefer',
    '',
  ].map(query => ({ field, query })));
  it.each(databaseTlsCases)('rejects ambiguous or weaker TLS on $field: $query', ({ field, query }) => {
    const value = input();
    const parsed = new URL(value.environment[field]);
    parsed.search = query;
    value.environment[field] = parsed.href;
    expect(() => validateInput(value)).toThrow(field);
  });
  it('refuses credentials in the source tree or an existing private installation', () => {
    expect(() => prepare(input(), path.join(repository, '.data-unit-installation'))).toThrow('outside-source');
    expect(() => prepare(input(), privateDir)).toThrow('already-exists');
  });
  it('refuses upstream local engine overrides in disposable mode', () => {
    const value = input('disposable'); value.environment.ZENITH_TEMPORAL_ADDRESS = 'remote.unit.invalid:7233';
    expect(() => validateInput(value)).toThrow('disposable-engine-overrides');
  });
  it('rejects a private input file inside the build context before any preparation writes', () => {
    const destination = path.join(temp, 'cli-rejected');
    const result = spawnSync(process.execPath, [path.join(repository, 'scripts/deploy/installation.mjs'), 'prepare', destination, path.join(repository, 'input-does-not-exist.json')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('installation:private-directory-outside-source');
    expect(fs.existsSync(destination)).toBe(false);
  });
  it('rejects unknown top-level and image keys before printing private input fields', () => {
    const canary = runtimeSecret();
    const value = input();
    const unknownInstallationKey = { ...value, registryPassword: canary };
    const unknownImageKey = { ...value, images: { ...value.images, registryPassword: canary } };
    expect(() => validateInput(unknownInstallationKey)).toThrow('unknown-installation-field');
    expect(() => validateInput(unknownImageKey)).toThrow('unknown-image-field');
  });
  it('rejects an outside input path whose ancestor symlink aliases the build context', () => {
    const alias = path.join(temp, 'source-alias');
    const name = `unit-private-input-${runtimeSecret()}.json`;
    const sourceInput = path.join(repository, 'deploy/self-hosted', name);
    const destination = path.join(temp, 'cli-symlink-rejected');
    fs.symlinkSync(repository, alias, 'dir');
    fs.writeFileSync(sourceInput, JSON.stringify(input()), { mode: 0o600, flag: 'wx' });
    try {
      const result = spawnSync(process.execPath, [path.join(repository, 'scripts/deploy/installation.mjs'), 'prepare', destination, path.join(alias, 'deploy/self-hosted', name)], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('installation:private-path-symlink');
      expect(fs.existsSync(destination)).toBe(false);
    } finally { fs.rmSync(sourceInput); }
  });
});

describe('private preparation and ownership', () => {
  it('prepares an additional worker from the private keyring with independent scratch and unchanged keys', () => {
    const directory = path.join(temp, 'joined-worker');
    const peer = prepareJoin(path.join(privateDir, 'keyring.json'), directory);
    expect(peer.environment).toEqual(production.environment);
    expect(peer.installationId).toBe(production.installationId);
    expect(readPrepared(directory)).toEqual(peer);
    const composition = JSON.parse(fs.readFileSync(path.join(directory, 'worker.compose.json'), 'utf8'));
    expect(Object.keys(composition.services)).toEqual([`execution-worker-${peer.workerId}`]);
    expect(composition.services[`execution-worker-${peer.workerId}`].volumes).toEqual([`worker-${peer.workerId}:/var/lib/zenith`]);
    expect(composeArgs(peer, directory)).toContain(path.join(directory, 'worker.compose.json'));
  });
  it('refuses keyring drift before creating any joined worker files', () => {
    const file = path.join(privateDir, 'keyring.json'), content = fs.readFileSync(file, 'utf8');
    const directory = path.join(temp, 'join-refused');
    try {
      const altered = JSON.parse(content); altered.environment.ZENITH_PLAN_ARTIFACT_KEY = runtimeSecret();
      fs.writeFileSync(file, JSON.stringify(altered));
      expect(() => prepareJoin(file, directory)).toThrow('join-keyring-drift');
      expect(fs.existsSync(directory)).toBe(false);
    } finally { fs.writeFileSync(file, content); }
  });
  it('generates private keys and a unique project at runtime, with separate scratch paths', () => {
    expect(production.installationId).not.toBe(disposable.installationId);
    expect(production.environment.ZENITH_PLAN_ARTIFACT_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(production.environment.ZENITH_PLAN_ARTIFACT_KEY).not.toBe(production.environment.ZENITH_SECRET_KEY);
    expect(production.environment.ZENITH_SECRET_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(production.environment.ZENITH_CONTROL_SIGNING_JWK)).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(JSON.parse(production.environment.ZENITH_OIDC_SIGNING_JWK)).toMatchObject({ kty: 'RSA' });
    expect(fs.statSync(privateDir).mode & 0o077).toBe(0);
    for (const file of fs.readdirSync(privateDir)) expect(fs.statSync(path.join(privateDir, file)).mode & 0o077).toBe(0);
    expect(fs.readFileSync(path.join(privateDir, 'api.env'), 'utf8')).toContain('ZENITH_DATA=/data');
    const worker = fs.readFileSync(path.join(privateDir, 'worker.env'), 'utf8');
    expect(worker).toContain('ZENITH_PLAN_ARTIFACT_KEY=');
    expect(fs.readFileSync(path.join(privateDir, 'api.env'), 'utf8')).not.toContain('ZENITH_PLAN_ARTIFACT_KEY=');
    expect(worker).toContain('ZENITH_DATA=/var/lib/zenith');
    expect(worker).toContain('ZENITH_WORKER_PLAN_DIR=/var/lib/zenith/plans');
    expect(worker).toContain('ZENITH_STORE=postgres');
    expect(worker).not.toContain('ZENITH_PLATFORM_MIGRATION_URL=');
    expect(readPrepared(privateDir)).toEqual(production);
  });
  it('rejects permissions drift and effective-env drift', () => {
    const file = path.join(privateDir, 'worker.env');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.chmodSync(file, 0o644);
      expect(() => readPrepared(privateDir)).toThrow('private-permissions');
      fs.chmodSync(file, 0o600);
      fs.appendFileSync(file, 'ZENITH_STORE=file\n');
      expect(() => readPrepared(privateDir)).toThrow('effective-configuration-drift');
    } finally { fs.chmodSync(file, 0o600); fs.writeFileSync(file, original); }
  });
  it('labels preparation evidence and unobserved acceptance honestly without secrets', () => {
    const plan = planFor(production); const serialized = JSON.stringify(plan);
    expect(plan).toMatchObject({ externalSupabaseRequired: true, fullyLocal: false, apiStartupApprovalRequired: true, networkValidated: false, productionReady: false });
    expect(plan.source.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.pendingAcceptance).toContain('customer-agent-registration-and-real-execution');
    for (const key of ['SUPABASE_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ZENITH_SECRET_KEY', 'ZENITH_PLAN_ARTIFACT_KEY', 'ZENITH_CONTROL_SIGNING_JWK', 'ZENITH_TEMPORAL_API_KEY']) expect(serialized).not.toContain(production.environment[key]);
    expect(planFor(disposable)).toMatchObject({ services: ['api', 'execution-worker', 'platform-db', 'temporal'], publishedEnginePorts: [] });
  });
  it('uses an explicit project and private env file, never the root fixture', () => {
    const args = composeArgs(disposable, fixtureDir);
    expect(args).toContain(disposable.projectName);
    expect(args).toContain(path.join(fixtureDir, 'compose.env'));
    expect(args).toContain(path.join(repository, 'deploy/self-hosted/compose.disposable.yml'));
    expect(args).not.toContain(path.join(repository, 'docker-compose.yml'));
    expect(args).not.toContain('up');
  });
  it('removes shell overrides of validated Compose settings while retaining Docker transport settings', () => {
    expect(composeEnvironment({ ZENITH_PRIVATE_DIR: '/other-private-directory', ZENITH_API_PORT: '80', ZENITH_INSTALLATION_ID: 'foreign', DOCKER_HOST: 'unix:///var/run/docker.sock', PATH: '/usr/bin' }))
      .toEqual({ DOCKER_HOST: 'unix:///var/run/docker.sock', PATH: '/usr/bin' });
  });
  it('rejects ancestor symlinks for preparation and reopened private installations', () => {
    const alias = path.join(temp, 'private-alias');
    fs.symlinkSync(temp, alias, 'dir');
    expect(() => prepare(input(), path.join(alias, 'new-private-installation'))).toThrow('private-path-symlink');
    expect(() => readPrepared(path.join(alias, 'production'))).toThrow('private-path-symlink');
  });
  it('rejects unknown prepared source keys and emits only explicit image/provenance fields', () => {
    const canary = runtimeSecret();
    const value = { ...production, images: { ...production.images, registryPassword: canary }, source: { ...production.source, registryPassword: canary } };
    const safe = planFor(value);
    expect(JSON.stringify(safe)).not.toContain(canary);
    expect(Object.keys(safe.images)).toEqual(['api', 'worker', 'migration']);
    expect(Object.keys(safe.source)).toEqual(['head', 'contentSha256', 'dirty']);
    expect(() => validateInput({ ...production, source: value.source }, true)).toThrow('unknown-source-field');
    expect(safe.additionalWorkerPreparationSupported).toBe(true);
  });
});

interface Service { image?: string; user?: string; ports?: string[]; volumes?: string[]; tmpfs?: string[]; read_only?: boolean; profiles?: string[]; depends_on?: Record<string, { condition: string }>; healthcheck?: {test:string[]}; labels?: Record<string,string>; env_file?: {format:string}[]; }
interface Composition { services: Record<string, Service>; volumes: Record<string, {labels:Record<string,string>}>; networks?: Record<string, {labels:Record<string,string>}>; }
describe('isolated default composition', () => {
  it('separates scratch volumes, uses live worker readiness and an explicit migrator', () => {
    const config = load(fs.readFileSync(path.join(repository, 'deploy/self-hosted/compose.yml'), 'utf8')) as Composition;
    expect(Object.keys(config.services)).toEqual(['api', 'execution-worker', 'platform-migrate']);
    expect(config.services.api.volumes).toContain('api-data:/data');
    expect(config.services.api.tmpfs).toContain('/app/.next/cache:rw,noexec,nosuid,size=512m,uid=1001,gid=1001,mode=1770');
    expect(config.volumes['api-cache']).toBeUndefined();
    expect(config.services['execution-worker'].volumes).toEqual(['worker-data:/var/lib/zenith']);
    expect(config.services['execution-worker'].healthcheck?.test.join(' ')).toContain('/readyz');
    expect(config.services['platform-migrate'].profiles).toEqual(['maintenance']);
    for (const service of Object.values(config.services)) {
      expect(service.read_only).toBe(true);
      expect(service.labels?.['io.zenith.installation']).toContain('ZENITH_INSTALLATION_ID');
      expect(service.env_file?.[0].format).toBe('raw');
    }
    for (const volume of Object.values(config.volumes)) expect(volume.labels['io.zenith.installation']).toContain('ZENITH_INSTALLATION_ID');
    expect(config.services.api.ports?.[0]).toMatch(/^127\.0\.0\.1:/);
  });
  it('pins real fixture engines, publishes neither, and waits for their real health checks', () => {
    const config = load(fs.readFileSync(path.join(repository, 'deploy/self-hosted/compose.disposable.yml'), 'utf8')) as Composition;
    for (const name of ['platform-db', 'temporal']) {
      expect(config.services[name].image).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(config.services[name].ports).toBeUndefined();
    }
    expect(config.services.temporal.user).toBe('1000:1000');
    expect(config.services.temporal.volumes).toEqual(['temporal-data:/home/temporal']);
    expect(config.services.api.depends_on?.temporal.condition).toBe('service_healthy');
    expect(config.services['platform-migrate'].depends_on?.['platform-db'].condition).toBe('service_healthy');
  });
  it('validates production and disposable Compose without pulling images or starting services', () => {
    expect(checkCompose(production, privateDir)).toMatchObject({ kind: 'configuration-only', composeConfigValid: true, servicesStarted: false });
    expect(checkCompose(disposable, fixtureDir)).toMatchObject({ kind: 'configuration-only', composeConfigValid: true, servicesStarted: false });
  });
});

describe('bounded read-only HTTP readiness', () => {
  const healthy: typeof fetch = async request => {
    const endpoint = new URL(String(request)).pathname;
    if (endpoint === '/api/me') return Response.json({ configured: true });
    if (endpoint === '/login') return new Response('<html></html>', {headers:{'content-type':'text/html'}});
    return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://zenith.unit.invalid/.well-known/oauth-protected-resource/api/agent/v3/mcp"' } });
  };
  it('checks auth configuration, HTML and the bearer boundary without claiming authenticated acceptance', async () => {
    const result = await probeReadiness(production, healthy);
    expect(result).toMatchObject({ ready: true, authenticatedAcceptance: false, browserInteractiveAcceptance: false, productionReady: false });
    expect(result.checks['mcp-oauth-metadata']).toBe('not-configured');
  });
  it('fails demo authentication, unavailable API, or a permissive MCP boundary', async () => {
    expect((await probeReadiness(production, async () => Response.json({configured:false}))).ready).toBe(false);
    const result = await probeReadiness(production, async () => { throw new Error(production.environment.SUPABASE_SERVICE_ROLE_KEY); });
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain(production.environment.SUPABASE_SERVICE_ROLE_KEY);
  });
  it('rejects a bearer challenge for a different MCP resource', async () => {
    const wrongResource: typeof fetch = async (request, init) => String(request).endsWith('/api/agent/v3/mcp')
      ? new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://zenith.unit.invalid/.well-known/oauth-protected-resource/api/agent/v2/mcp"' } })
      : healthy(request, init);
    expect((await probeReadiness(production, wrongResource)).checks['mcp-bearer-boundary']).toBe('failed');
  });
  it('requires configured OAuth discovery to name the trusted issuer and v3 resource', async () => {
    const environment: Record<string, string> = { ...production.environment, ZENITH_AGENT_OAUTH_ISSUER: 'https://oauth.unit.invalid', ZENITH_AGENT_OAUTH_JWKS: 'https://oauth.unit.invalid/jwks' };
    const config = { ...production, environment };
    const wrongIssuer: typeof fetch = async (request, init) => String(request).includes('?metadata=')
      ? Response.json({ resource: `${config.environment.NEXT_PUBLIC_SITE_URL}/api/agent/v3/mcp`, authorization_servers: ['https://wrong.unit.invalid'] })
      : healthy(request, init);
    expect((await probeReadiness(config, wrongIssuer)).checks['mcp-oauth-metadata']).toBe('failed');
    const trustedIssuer: typeof fetch = async (request, init) => String(request).includes('?metadata=')
      ? Response.json({ resource: `${config.environment.NEXT_PUBLIC_SITE_URL}/api/agent/v3/mcp`, authorization_servers: [config.environment.ZENITH_AGENT_OAUTH_ISSUER] })
      : healthy(request, init);
    expect((await probeReadiness(config, trustedIssuer)).ready).toBe(true);
  });
});
