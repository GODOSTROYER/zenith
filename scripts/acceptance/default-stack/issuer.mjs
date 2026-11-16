import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { prepare } from '../../../deploy/acceptance/oauth-issuer/prepare.mjs';
import { readPrepared, environmentsFor, assertPrivate, joinComposition } from '../../deploy/installation.mjs';
import { readState, compose, docker, save, cli, requireEngineGate } from './runtime.mjs';
import { root, ports, fail } from './config.mjs';
import { supabaseRequest, readiness } from './readiness.mjs';

export const issuer = 'https://issuer.zenith.localhost:8443/realms/zenith-interop';
export function issuerBindings() { return { ZENITH_AGENT_OAUTH_ISSUER: issuer, ZENITH_AGENT_OAUTH_JWKS: `${issuer}/protocol/openid-connect/certs`, ZENITH_AGENT_OAUTH_CLIENT_CLAIM: 'azp', ZENITH_AGENT_OAUTH_SUBJECT_CLAIM: 'zenith_subject' }; }

/** Join the real issuer to the already-owned default stack and exact existing Auth identity. */
export async function joinIssuer(directory, subject) {
  requireEngineGate();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(subject ?? '')) fail('issuer-subject');
  const state = readState(directory), installation = path.join(state.directory, 'installation');
  const config = readPrepared(installation);
  if (state.issuer || config.environment.ZENITH_AGENT_OAUTH_ISSUER) fail('issuer-already-configured');
  await readiness(state);
  const user = await supabaseRequest(state, `/auth/v1/admin/users/${subject}`, { apikey: config.environment.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${config.environment.SUPABASE_SERVICE_ROLE_KEY}` });
  const identity = JSON.parse(user.body);
  if (user.status !== 200 || identity.id !== subject || !identity.email_confirmed_at) fail('issuer-live-subject');
  const fixture = path.join(state.directory, 'issuer');
  // The standalone generator retains its HTTPS-only loopback contract. The
  // joined adapter binds only J1's exact local API origin to the signed audience.
  await prepare({ dir: fixture, origin: `https://localhost:${ports.api}`, subject, issuer });
  const realmFile = path.join(fixture, 'realm.json'), realm = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
  const mapper = realm.clientScopes.find(item => item.name === 'zenith-binding').protocolMappers.find(item => item.protocolMapper === 'oidc-audience-mapper');
  if (config.environment.NEXT_PUBLIC_SITE_URL !== `http://127.0.0.1:${ports.api}`) fail('issuer-api-origin');
  mapper.config['included.custom.audience'] = `${config.environment.NEXT_PUBLIC_SITE_URL}/api/agent/v3/mcp`;
  fs.writeFileSync(realmFile, JSON.stringify(realm), { mode: 0o644 });
  const caFile = path.join(state.directory, 'tls/ca.crt'); assertPrivate(path.dirname(caFile), true);
  const ca = fs.readFileSync(caFile, 'utf8') + '\n' + fs.readFileSync(path.join(fixture, 'tls/ca.crt'), 'utf8');
  fs.writeFileSync(caFile, ca, { mode: 0o644 });
  const composeFile = path.join(installation, 'stack.compose.json'), document = JSON.parse(fs.readFileSync(composeFile, 'utf8'));
  const service = load(fs.readFileSync(path.join(root, 'deploy/acceptance/oauth-issuer/compose.yaml'), 'utf8')).services.issuer;
  const credentials = JSON.parse(fs.readFileSync(path.join(fixture, 'credentials.json'), 'utf8'));
  document.services.issuer = { ...service, labels: { 'io.zenith.installation': state.installationId },
    command: service.command.map(item => item === '--hostname=https://localhost:8443' ? '--hostname=https://issuer.zenith.localhost:8443' : item),
    environment: { KC_BOOTSTRAP_ADMIN_USERNAME: credentials.adminUsername, KC_BOOTSTRAP_ADMIN_PASSWORD: credentials.adminPassword, JAVA_OPTS_KC_HEAP: '-Xms64m -Xmx256m' },
    volumes: [`${realmFile}:/opt/keycloak/data/import/zenith-interop-realm.json:ro`, `${path.join(fixture, 'tls')}:/fixture-tls:ro`],
    networks: { installation: { aliases: ['issuer.zenith.localhost'] } }, mem_limit: '384m' };
  await docker(['pull', service.image]);
  const [image] = JSON.parse(await docker(['image', 'inspect', service.image]));
  if (image.Architecture !== ({ arm64: 'arm64', x64: 'amd64' }[process.arch])) fail('issuer-native-architecture');
  fs.writeFileSync(composeFile, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
  state.compositionSha256 = createHash('sha256').update(fs.readFileSync(composeFile)).digest('hex');
  state.issuer = issuer; save(path.join(state.directory, 'state.json'), state);
  for (const dir of [installation, ...(state.profile === 'default' ? [path.join(state.directory, 'worker-peer')] : [])]) {
    const prepared = dir === installation ? config : readPrepared(dir);
    Object.assign(prepared.environment, issuerBindings());
    for (const [name, env] of Object.entries(environmentsFor(prepared, dir))) {
      const file = path.join(dir, name); assertPrivate(file);
      fs.writeFileSync(file, Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    }
    fs.writeFileSync(path.join(dir, 'installation.json'), JSON.stringify(prepared, null, 2) + '\n', { mode: 0o600 });
    if (prepared.workerId) fs.writeFileSync(path.join(dir, 'worker.compose.json'), JSON.stringify(joinComposition(prepared, dir), null, 2) + '\n', { mode: 0o600 });
    readPrepared(dir);
  }
  await compose(state, ['up', '-d', 'issuer']);
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    ready = await new Promise(resolve => {
      const req = https.get(`${issuer}/.well-known/openid-configuration`, { ca, timeout: 3000 }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
        response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(body).issuer === issuer); } catch { resolve(false); } });
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
    });
    if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) fail('issuer-readiness');
  await compose(state, ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300', 'api', 'execution-worker', ...(state.profile === 'default' ? ['api-peer', 'execution-worker-peer'] : [])]);
  return readiness(state);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(async () => {
  const [directory, subject, ...extra] = process.argv.slice(2);
  if (!directory || !subject || extra.length) fail('issuer-usage');
  const receipt = await joinIssuer(directory, subject);
  process.stdout.write(JSON.stringify({ issuer, passed: receipt.passed, failed: receipt.failed, skipped: receipt.skipped }) + '\n');
});
