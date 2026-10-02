import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** @typedef {{mode:'production'|'disposable', apiPort:number, images:{api:string,worker:string,migration:string}, environment:Record<string,string>}} InstallationInput */
/** @typedef {InstallationInput & {schemaVersion:1,installationId:string,projectName:string,source:{head:string,contentSha256:string,dirty:boolean}}} PreparedInstallation */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = path.join(root, 'deploy/self-hosted/compose.yml');
const overlay = path.join(root, 'deploy/self-hosted/compose.disposable.yml');
const fields = new Set([
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS', 'NEXT_PUBLIC_SITE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL', 'ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_MIGRATION_URL',
  'ZENITH_TEMPORAL_ADDRESS', 'ZENITH_TEMPORAL_NAMESPACE', 'ZENITH_TEMPORAL_TLS',
  'ZENITH_TEMPORAL_API_KEY', 'ZENITH_AGENT_OAUTH_ISSUER', 'ZENITH_AGENT_OAUTH_JWKS',
  'ZENITH_AGENT_OAUTH_CLIENT_CLAIM', 'ZENITH_AGENT_OAUTH_SUBJECT_CLAIM',
]);
const generated = new Set(['ZENITH_SECRET_KEY', 'ZENITH_CONTROL_SIGNING_JWK', 'ZENITH_OIDC_SIGNING_JWK']);
const hash = (/** @type {string|Buffer} */ value) => createHash('sha256').update(value).digest('hex');
const refuse = (/** @type {string} */ id) => { throw new Error(`installation:${id}`); };
const loopback = (/** @type {string} */ host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** Only trusted field identifiers enter errors. Credential values never do.
 * @param {unknown} value @param {string} field @returns {string} */
function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)
    || /(?:change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_]|example\.(?:com|org)|<[^>]*>)/i.test(value)) refuse(field);
  return /** @type {string} */ (value);
}
/** @param {string} value @param {string} field @returns {URL} */
function url(value, field) {
  try { return new URL(value); } catch { return refuse(field); }
}
/** @param {string} value @param {string} field @param {boolean} https */
function webUrl(value, field, https = true) {
  const parsed = url(text(value, field), field);
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (https ? parsed.protocol !== 'https:' : parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback(parsed.hostname)))) refuse(field);
  return parsed;
}
/** @param {string} value @param {string} field @param {boolean} tls */
function databaseUrl(value, field, tls) {
  const parsed = url(text(value, field), field);
  // URLSearchParams.get() reads the first value; postgres.js uses the last.
  // Reject ambiguity before either driver can reinterpret the TLS setting.
  const sslModes = parsed.searchParams.getAll('sslmode');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username
    || !parsed.password || parsed.pathname.length < 2 || parsed.hash
    || sslModes.length > 1
    || (tls && (loopback(parsed.hostname) || sslModes.length !== 1 || sslModes[0] !== 'verify-full'))) refuse(field);
  // Additional URL options can override driver TLS defaults; accept only sslmode.
  if ([...parsed.searchParams.keys()].some(key => key !== 'sslmode')) refuse(field);
  return parsed;
}

/** Structural preflight only: no assertion of network, identity or tool readiness.
 * @param {InstallationInput|PreparedInstallation} input @param {boolean} prepared @returns {InstallationInput|PreparedInstallation} */
export function validateInput(input, prepared = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['production', 'disposable'].includes(input.mode)) refuse('mode');
  const allowed = new Set(['mode', 'apiPort', 'images', 'environment', ...(prepared ? ['schemaVersion', 'installationId', 'projectName', 'source'] : [])]);
  if (Object.keys(input).some(key => !allowed.has(key))) refuse('unknown-installation-field');
  if (!Number.isInteger(input.apiPort) || input.apiPort < 1024 || input.apiPort > 65535) refuse('apiPort');
  if (!input.images || typeof input.images !== 'object' || Array.isArray(input.images)) refuse('images');
  if (Object.keys(input.images).some(key => !['api', 'worker', 'migration'].includes(key))) refuse('unknown-image-field');
  for (const id of /** @type {const} */ (['api', 'worker', 'migration'])) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(text(input.images?.[id], `images.${id}`))) refuse(`images.${id}`);
  }
  const env = input.environment;
  if (!env || typeof env !== 'object' || Array.isArray(env)) refuse('environment');
  for (const key of Object.keys(env)) {
    if (!fields.has(key) && !(prepared && generated.has(key))) refuse('unknown-environment-field');
    text(env[key], fields.has(key) || generated.has(key) ? key : 'environment');
  }
  const site = webUrl(env.NEXT_PUBLIC_SITE_URL, 'NEXT_PUBLIC_SITE_URL', input.mode === 'production');
  if (site.pathname !== '/' || site.origin !== env.NEXT_PUBLIC_SITE_URL) refuse('NEXT_PUBLIC_SITE_URL');
  const supabase = webUrl(env.SUPABASE_URL, 'SUPABASE_URL');
  if (supabase.pathname !== '/' || env.SUPABASE_URL !== env.NEXT_PUBLIC_SUPABASE_URL) refuse('NEXT_PUBLIC_SUPABASE_URL');
  if (text(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY').length < 20) refuse('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (text(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY').length < 32
    || env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) refuse('SUPABASE_SERVICE_ROLE_KEY');
  const product = databaseUrl(env.SUPABASE_DB_URL, 'SUPABASE_DB_URL', true);
  if (product.port !== '6543') refuse('SUPABASE_DB_URL-transaction-pooler');
  if (input.mode === 'production' || prepared) {
    const platform = databaseUrl(env.ZENITH_PLATFORM_DB_URL, 'ZENITH_PLATFORM_DB_URL', input.mode === 'production');
    const migrator = databaseUrl(env.ZENITH_PLATFORM_MIGRATION_URL, 'ZENITH_PLATFORM_MIGRATION_URL', input.mode === 'production');
    if (migrator.host !== platform.host || migrator.pathname !== platform.pathname) refuse('platform-migration-authority');
    // Require a separate server authority, not merely a different username or DB.
    if (platform.hostname === product.hostname) refuse('separate-platform-authority');
    text(env.ZENITH_TEMPORAL_NAMESPACE, 'ZENITH_TEMPORAL_NAMESPACE');
    const address = url(`http://${text(env.ZENITH_TEMPORAL_ADDRESS, 'ZENITH_TEMPORAL_ADDRESS')}`, 'ZENITH_TEMPORAL_ADDRESS');
    if (!address.port || address.pathname !== '/' || address.username || address.password || address.search || address.hash) refuse('ZENITH_TEMPORAL_ADDRESS');
    if (input.mode === 'production') {
      if (loopback(address.hostname) || env.ZENITH_TEMPORAL_TLS !== 'true') refuse('ZENITH_TEMPORAL_TLS');
      if (text(env.ZENITH_TEMPORAL_API_KEY, 'ZENITH_TEMPORAL_API_KEY').length < 20) refuse('ZENITH_TEMPORAL_API_KEY');
    } else if (address.host !== 'temporal:7233' || env.ZENITH_TEMPORAL_TLS !== 'false'
      || env.ZENITH_TEMPORAL_API_KEY || platform.host !== 'platform-db:5432'
      || platform.pathname !== '/zenith_platform' || platform.search) refuse('disposable-engine-binding');
  } else if (['ZENITH_PLATFORM_DB_URL', 'ZENITH_PLATFORM_MIGRATION_URL', 'ZENITH_TEMPORAL_ADDRESS', 'ZENITH_TEMPORAL_NAMESPACE', 'ZENITH_TEMPORAL_TLS', 'ZENITH_TEMPORAL_API_KEY'].some(key => env[key])) {
    refuse('disposable-engine-overrides');
  }
  if (env.ZENITH_AGENT_OAUTH_ISSUER || env.ZENITH_AGENT_OAUTH_JWKS) {
    webUrl(env.ZENITH_AGENT_OAUTH_ISSUER, 'ZENITH_AGENT_OAUTH_ISSUER');
    webUrl(env.ZENITH_AGENT_OAUTH_JWKS, 'ZENITH_AGENT_OAUTH_JWKS');
    if (env.ZENITH_AGENT_OAUTH_CLIENT_CLAIM && !['client_id', 'azp'].includes(env.ZENITH_AGENT_OAUTH_CLIENT_CLAIM)) refuse('ZENITH_AGENT_OAUTH_CLIENT_CLAIM');
    if (env.ZENITH_AGENT_OAUTH_SUBJECT_CLAIM && !/^[A-Za-z][A-Za-z0-9_:/.-]{0,199}$/.test(env.ZENITH_AGENT_OAUTH_SUBJECT_CLAIM)) refuse('ZENITH_AGENT_OAUTH_SUBJECT_CLAIM');
  }
  if (prepared) {
    if (!('source' in input) || !input.source || typeof input.source !== 'object' || Array.isArray(input.source)) refuse('source-binding');
    const binding = input.source;
    if (Object.keys(binding).some(key => !['head', 'contentSha256', 'dirty'].includes(key))) refuse('unknown-source-field');
    if (!/^[a-f0-9]{40}$/.test(binding.head) || !/^[a-f0-9]{64}$/.test(binding.contentSha256) || typeof binding.dirty !== 'boolean') refuse('source-binding');
    if (!/^[a-f0-9]{64}$/.test(env.ZENITH_SECRET_KEY)) refuse('ZENITH_SECRET_KEY');
    for (const [field, kty] of [['ZENITH_CONTROL_SIGNING_JWK', 'OKP'], ['ZENITH_OIDC_SIGNING_JWK', 'RSA']]) {
      try {
        const key = JSON.parse(env[field]);
        if (key.kty !== kty || !key.d || (kty === 'OKP' && key.crv !== 'Ed25519')) refuse(field);
        const imported = createPrivateKey({ key, format: 'jwk' });
        if (kty === 'RSA' && (imported.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) refuse(field);
      } catch { refuse(field); }
    }
  }
  return input;
}

/** Hash current tracked AND untracked nonignored source contents; no contents emitted. */
function sourceBinding() {
  const run = (/** @type {string[]} */ args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) refuse('source-binding');
    return result.stdout;
  };
  const digest = createHash('sha256');
  const files = run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  for (const file of files) {
    digest.update(file).update('\0');
    const location = path.join(root, file);
    if (!fs.existsSync(location)) { digest.update('deleted\0'); continue; }
    digest.update(fs.lstatSync(location).isSymbolicLink() ? fs.readlinkSync(location) : fs.readFileSync(location)).update('\0');
  }
  return { head: run(['rev-parse', 'HEAD']).trim(), contentSha256: digest.digest('hex'), dirty: Boolean(run(['status', '--porcelain']).trim()) };
}
/** @param {string} location */
function privateLocation(location) {
  const resolved = path.resolve(location);
  if (!/^[A-Za-z0-9_./-]+$/.test(resolved) || resolved === root || resolved.startsWith(`${root}${path.sep}`)) refuse('private-directory-outside-source');
  // Check every existing component, including inputs and reopened installations.
  // A lexical outside-source path may otherwise alias a file inside COPY's context.
  for (let component = resolved; component !== path.dirname(component); component = path.dirname(component)) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) refuse('private-path-symlink');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return resolved;
}
/** @param {string} location @param {boolean} directory */
function assertPrivate(location, directory = false) {
  const stat = fs.lstatSync(location);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) refuse('private-permissions');
}
/** @param {string} location @param {unknown} value */
function writeJson(location, value) { fs.writeFileSync(location, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
/** Raw Compose env_file syntax. Keys trusted, values single-line; $ stays literal.
 * @param {string} location @param {Record<string,string>} env */
function writeEnv(location, env) { fs.writeFileSync(location, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' }); }

/** @param {PreparedInstallation} config @param {string} dir @returns {Record<string,Record<string,string>>} */
function environmentsFor(config, dir) {
  const { ZENITH_PLATFORM_MIGRATION_URL: migrationUrl, ...runtime } = config.environment;
  const common = { ...runtime, NODE_ENV: 'production', ZENITH_STORE: 'postgres', ZENITH_HOSTED_STORE: 'postgres', ZENITH_PLATFORM_DB: 'postgres', ZENITH_PLATFORM_DB_MAX: '5',
    ZENITH_AGENT_CONTROL: '1', ZENITH_AGENT_ORIGIN: runtime.NEXT_PUBLIC_SITE_URL, ZENITH_OIDC_ISSUER: `${runtime.NEXT_PUBLIC_SITE_URL}/api/oidc` };
  return {
    'api.env': { ...common, PORT: '3400', HOSTNAME: '0.0.0.0', ZENITH_DATA: '/data' },
    'worker.env': { ...common, ZENITH_DATA: '/var/lib/zenith', HOME: '/var/lib/zenith', ZENITH_WORKER_PLAN_DIR: '/var/lib/zenith/plans', ZENITH_WORKER_HEALTH_PORT: '9464', ZENITH_WORKER_TASK_QUEUE: 'zenith-execution' },
    'migration.env': { NODE_ENV: 'production', ZENITH_PLATFORM_DB: 'postgres', ZENITH_PLATFORM_DB_URL: migrationUrl, ZENITH_PLATFORM_DB_MAX: '1' },
    'compose.env': { ZENITH_INSTALLATION_ID: config.installationId, ZENITH_PRIVATE_DIR: dir, ZENITH_API_PORT: String(config.apiPort), ZENITH_API_IMAGE: config.images.api, ZENITH_WORKER_IMAGE: config.images.worker, ZENITH_MIGRATION_IMAGE: config.images.migration },
    ...(config.mode === 'disposable' ? { 'platform.env': { POSTGRES_DB: 'zenith_platform', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: decodeURIComponent(new URL(runtime.ZENITH_PLATFORM_DB_URL).password) } } : {}),
  };
}

/** @param {InstallationInput} input @param {string} directory @returns {PreparedInstallation} */
export function prepare(input, directory) {
  validateInput(input);
  const dir = privateLocation(directory);
  if (fs.existsSync(dir)) refuse('private-directory-already-exists');
  const environment = { ...input.environment };
  const id = randomBytes(12).toString('hex');
  environment.ZENITH_SECRET_KEY = randomBytes(32).toString('hex');
  const control = generateKeyPairSync('ed25519');
  const oidc = generateKeyPairSync('rsa', { modulusLength: 2048 });
  environment.ZENITH_CONTROL_SIGNING_JWK = JSON.stringify({ ...control.privateKey.export({ format: 'jwk' }), kid: `control-${id}`, alg: 'EdDSA' });
  environment.ZENITH_OIDC_SIGNING_JWK = JSON.stringify({ ...oidc.privateKey.export({ format: 'jwk' }), kid: `oidc-${id}`, alg: 'RS256' });
  if (input.mode === 'disposable') {
    const password = randomBytes(32).toString('hex');
    environment.ZENITH_PLATFORM_DB_URL = `postgresql://postgres:${password}@platform-db:5432/zenith_platform`;
    environment.ZENITH_PLATFORM_MIGRATION_URL = environment.ZENITH_PLATFORM_DB_URL;
    environment.ZENITH_TEMPORAL_ADDRESS = 'temporal:7233';
    environment.ZENITH_TEMPORAL_NAMESPACE = 'zenith-disposable';
    environment.ZENITH_TEMPORAL_TLS = 'false';
  }
  /** @type {PreparedInstallation} */
  const result = { ...input, environment, schemaVersion: 1, installationId: id, projectName: `zenith-${id}`, source: sourceBinding() };
  validateInput(result, true);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  assertPrivate(dir, true);
  writeJson(path.join(dir, 'installation.json'), result);
  for (const [name, env] of Object.entries(environmentsFor(result, dir))) writeEnv(path.join(dir, name), env);
  writeJson(path.join(dir, 'plan.json'), planFor(result));
  return result;
}

/** @param {PreparedInstallation} config */
export function planFor(config) {
  return { schemaVersion: 1, installationId: config.installationId, projectName: config.projectName, mode: config.mode,
    source: { head: config.source.head, contentSha256: config.source.contentSha256, dirty: config.source.dirty }, configurationSha256: hash(JSON.stringify(config)),
    services: config.mode === 'production' ? ['api', 'execution-worker'] : ['api', 'execution-worker', 'platform-db', 'temporal'],
    maintenance: ['platform-migrate'], workerReplicasPerProject: 1, additionalWorkerPreparationSupported: false, apiBinding: `127.0.0.1:${config.apiPort}`, siteOrigin: config.environment.NEXT_PUBLIC_SITE_URL, publishedEnginePorts: [],
    limits: { production: { cpu: 4, memoryGiB: 5 }, disposable: { cpu: 6, memoryGiB: 7 }, maintenanceAdditional: { cpu: 1, memoryGiB: 1 } },
    volumes: ['api-data', 'worker-data', ...(config.mode === 'disposable' ? ['platform-data', 'temporal-data'] : [])],
    images: { api: config.images.api, worker: config.images.worker, migration: config.images.migration }, externalSupabaseRequired: true, fullyLocal: false, apiStartupApprovalRequired: true,
    networkValidated: false, productionReady: false,
    pendingAcceptance: ['image-build-and-baked-public-auth', 'supabase-migrations-and-sign-in', 'pooler-and-platform-tls', 'temporal-auth-and-recovery', 'api-browser-and-mcp-live', 'customer-agent-registration-and-real-execution', 'multiworker-concurrency-and-backup-restore'],
    mcpOAuthConfigured: Boolean(config.environment.ZENITH_AGENT_OAUTH_ISSUER),
  };
}

/** @param {string} directory @returns {PreparedInstallation} */
export function readPrepared(directory) {
  const dir = privateLocation(directory);
  assertPrivate(dir, true);
  assertPrivate(path.join(dir, 'installation.json'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'installation.json'), 'utf8'));
  if (config.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(config.installationId) || config.projectName !== `zenith-${config.installationId}`) refuse('installation-identity');
  validateInput(config, true);
  for (const [name, env] of Object.entries(environmentsFor(config, dir))) {
    const file = path.join(dir, name);
    assertPrivate(file);
    const expected = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    if (fs.readFileSync(file, 'utf8') !== expected) refuse('effective-configuration-drift');
  }
  return config;
}
/** Safe argv, with no secret values; no startup/cleanup commands.
 * @param {PreparedInstallation} config @param {string} directory */
export function composeArgs(config, directory) {
  return ['compose', '--project-name', config.projectName, '--env-file', path.join(privateLocation(directory), 'compose.env'), '-f', compose,
    ...(config.mode === 'disposable' ? ['-f', overlay] : [])];
}
/** Compose interpolation must use validated private settings, not shell overrides.
 * @param {Record<string,string|undefined>} environment @returns {Record<string,string|undefined>} */
export function composeEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of ['ZENITH_INSTALLATION_ID', 'ZENITH_PRIVATE_DIR', 'ZENITH_API_PORT', 'ZENITH_API_IMAGE', 'ZENITH_WORKER_IMAGE', 'ZENITH_MIGRATION_IMAGE']) delete result[key];
  return result;
}
/** @param {PreparedInstallation} config @param {string} directory */
export function checkCompose(config, directory) {
  const result = spawnSync('docker', [...composeArgs(config, directory), 'config', '--quiet'], { cwd: root, env: composeEnvironment(), encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) refuse('compose-config'); // Never emit stderr; Compose can expand secrets.
  return { schemaVersion: 1, kind: 'configuration-only', configurationSha256: hash(JSON.stringify(config)), composeConfigValid: true, servicesStarted: false };
}

/** Read-only real endpoint checks. Results contain trusted IDs, never bodies/errors.
 * @param {PreparedInstallation} config @param {typeof fetch} fetcher */
export async function probeReadiness(config, fetcher = fetch) {
  const origin = config.environment.NEXT_PUBLIC_SITE_URL;
  /** @type {Record<string,string>} */ const checks = {};
  const probe = async (/** @type {string} */ id, /** @type {string} */ endpoint, /** @type {(response:Response)=>Promise<boolean>} */ accept) => {
    try {
      const response = await fetcher(`${origin}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      checks[id] = await accept(response) ? 'passed' : 'failed';
    } catch { checks[id] = 'failed'; }
  };
  await probe('api-configured', '/api/me', async r => r.ok && (await r.json()).configured === true);
  await probe('browser-login-http', '/login', async r => r.ok && (r.headers.get('content-type') ?? '').includes('text/html'));
  await probe('mcp-bearer-boundary', '/api/agent/v3/mcp', async r => r.status === 401 && (r.headers.get('www-authenticate') ?? '').includes(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/agent/v3/mcp"`));
  if (config.environment.ZENITH_AGENT_OAUTH_ISSUER) {
    await probe('mcp-oauth-metadata', '/api/agent/v3/mcp?metadata=oauth-protected-resource', async r => {
      if (!r.ok) return false;
      const body = await r.json();
      return body.resource === `${origin}/api/agent/v3/mcp` && body.authorization_servers?.length === 1 && body.authorization_servers[0] === config.environment.ZENITH_AGENT_OAUTH_ISSUER;
    });
  } else checks['mcp-oauth-metadata'] = 'not-configured';
  return { schemaVersion: 1, kind: 'http-readiness-only', configurationSha256: hash(JSON.stringify(config)), checks,
    ready: Object.values(checks).every(status => status === 'passed' || status === 'not-configured'),
    authenticatedAcceptance: false, browserInteractiveAcceptance: false, productionReady: false };
}

/** @param {string[]} args */
async function main(args) {
  const [command, directory, inputFile] = args;
  if (!directory || args.length > 3) refuse('usage');
  if (command === 'prepare') {
    if (!inputFile) refuse('input-file');
    privateLocation(inputFile);
    assertPrivate(inputFile);
    const config = prepare(JSON.parse(fs.readFileSync(inputFile, 'utf8')), directory);
    process.stdout.write(`${JSON.stringify(planFor(config))}\n`);
    return;
  }
  const config = readPrepared(directory);
  if (command === 'preflight') process.stdout.write(`${JSON.stringify(planFor(config))}\n`);
  else if (command === 'compose-check') process.stdout.write(`${JSON.stringify(checkCompose(config, directory))}\n`);
  else if (command === 'readiness') {
    const result = await probeReadiness(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ready) process.exitCode = 1;
  } else refuse('usage');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Filesystem, JSON and provider failures may contain credentials or paths.
    const id = error instanceof Error && /^installation:[A-Za-z0-9._-]+$/.test(error.message) ? error.message : 'installation:preparation-failed';
    process.stderr.write(`${id}\n`);
    process.exitCode = 1;
  });
}
