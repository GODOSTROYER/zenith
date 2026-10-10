import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertPrivate, privateLocation, composeEnvironment } from '../../deploy/installation.mjs';
import { cleanupPlan, fail, owns, root, installationLabel, projectLabel } from './config.mjs';

export function requireEngineGate() {
  if (process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== '1') fail('requires-ZENITH_ACCEPTANCE_DEFAULT_STACK');
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('node22');
  if (process.platform === 'win32') fail('requires-posix-private-permissions');
  if (!process.getuid?.()) fail('requires-unprivileged-host-user');
}
let resourceGuard;
export function setResourceGuard(guard) { resourceGuard = guard; }
// Capture privately in memory. Commands, stderr and bodies may contain credentials;
// errors expose a trusted operation identifier only. Never invoke a shell.
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    resourceGuard?.();
    const child = spawn(command, args, { cwd: options.cwd ?? root,
      env: { ...composeEnvironment(), ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, done = false, aborted = false, failureId = options.id ?? 'command-failed';
    const abort = () => { aborted = true; child.kill('SIGTERM'); };
    const timer = setTimeout(abort, options.timeout ?? 300_000);
    const monitor = setInterval(() => { try { resourceGuard?.(); } catch { failureId = 'disk-headroom'; abort(); } }, 5000);
    const settle = ok => { if (done) return; done = true; clearTimeout(timer); clearInterval(monitor); if (ok && !aborted) resolve(output.trim()); else reject(new Error(`default-stack:${failureId}`)); };
    child.on('error', () => settle(false));
    child.stdout.on('data', data => { size += data.length; if (size > 16 * 1024 * 1024) abort(); else output += data; });
    child.stderr.on('data', () => {});
    child.on('close', code => settle(code === 0));
    child.stdin.end(options.input);
  });
}
export const docker = (args, options = {}) => run('docker', args, options);
export const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export function readState(directory) {
  const dir = privateLocation(directory); assertPrivate(dir, true);
  const file = path.join(dir, 'state.json'); assertPrivate(file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  cleanupPlan([], state);
  if (state.directory !== dir) fail('private-directory-binding');
  return state;
}
export function compose(state, args) {
  const dir = path.join(state.directory, 'installation');
  const file = path.join(dir, 'stack.compose.json'); assertPrivate(file);
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== state.compositionSha256) fail('composition-drift');
  return docker(['compose', '--project-name', state.applicationProjectName, '--env-file', path.join(dir, 'compose.env'), '-f', path.join(dir, 'stack.compose.json'), ...args]);
}

/** Enumerate only two exact owner labels. Independently inspect before any deletion. */
export async function inventory(state) {
  const resources = [];
  for (const kind of ['container', 'volume', 'network', 'image']) {
    const ids = new Set();
    for (const label of [`${installationLabel}=${state.installationId}`, `${projectLabel}=${state.projectId}`,
      ...(state.applicationInstallationId ? [`${installationLabel}=${state.applicationInstallationId}`] : [])]) {
      const args = kind === 'container' ? ['container', 'ls', '-aq'] : [kind, 'ls', '-q'];
      const result = await docker([...args, '--filter', `label=${label}`]);
      for (const id of result.split(/\s+/).filter(Boolean)) ids.add(id);
    }
    for (const id of ids) {
      const [item] = JSON.parse(await docker([kind, 'inspect', id]));
      const labels = item.Config?.Labels ?? item.Labels;
      if (!owns(labels, state)) fail('resource-ownership');
      resources.push({ kind, id: kind === 'volume' ? item.Name : item.Id, labels, item });
    }
  }
  return resources;
}

function assertJ4Node(target, boundary, top = false) {
  const resolved = path.resolve(target);
  if (resolved !== target || !resolved.startsWith(`${boundary}${path.sep}`)) fail('j4-cleanup-path');
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.nlink > 1 && stat.isFile()) fail('j4-cleanup-owner');
  if (top) assertPrivate(resolved, stat.isDirectory());
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, directory: stat.isDirectory() };
}

function removeJ4PrivateTree(target, boundary, top = false) {
  const identity = assertJ4Node(target, boundary, top);
  if (identity.directory) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === '.' || entry === '..' || entry.includes(path.sep)) fail('j4-cleanup-path');
      removeJ4PrivateTree(path.join(target, entry), boundary);
    }
  }
  const current = assertJ4Node(target, boundary, top);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid
    || current.mode !== identity.mode || current.directory !== identity.directory) fail('j4-cleanup-identity');
  if (identity.directory) fs.rmdirSync(target);
  else fs.unlinkSync(target);
}

function cleanupJ4PrivateMaterials(state) {
  const directory = path.join(state.directory, 'j4');
  try { fs.lstatSync(directory); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  privateLocation(directory); assertPrivate(directory, true);
  const ownershipFile = path.join(directory, 'ownership.json'); assertPrivate(ownershipFile);
  const manifest = JSON.parse(fs.readFileSync(ownershipFile, 'utf8'));
  if (manifest.kind !== 'j4_owned_stack' || manifest.installationId !== state.installationId
    || manifest.applicationInstallationId !== state.applicationInstallationId || manifest.projectId !== state.projectId
    || manifest.applicationProjectName !== state.applicationProjectName || manifest.namespace !== state.j4Namespace
    || manifest.temporalPort !== state.j4TemporalPort || JSON.stringify(manifest.source) !== JSON.stringify(state.source)
    || !manifest.j4PrivatePaths) fail('j4-cleanup-binding');
  const paths = manifest.j4PrivatePaths;
  const expected = { data: path.join(directory, 'data'), home: path.join(directory, 'home'), planDirectory: path.join(directory, 'data/plans') };
  if (JSON.stringify(paths) !== JSON.stringify(expected)) fail('j4-cleanup-path');
  const secretFiles = [
    ['api.env', manifest.j4ApiEnvironmentSha256], ['worker.env', manifest.j4WorkerEnvironmentSha256],
    ['maintenance.env', manifest.maintenanceOverlaySha256], ['cron.secret', manifest.cronSecretSha256],
    ['canonical.stack.compose.json', manifest.canonicalCompositionSha256],
  ];
  for (const [name, digest] of secretFiles) {
    const target = path.join(directory, name);
    try { fs.lstatSync(target); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; } // A previously completed cleanup remains retryable.
    assertPrivate(target);
    if (!/^[a-f0-9]{64}$/.test(digest ?? '') || createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== digest) fail('j4-cleanup-content');
    removeJ4PrivateTree(target, directory, true);
  }
  for (const target of [paths.home, paths.data]) {
    try { fs.lstatSync(target); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    privateLocation(target); assertPrivate(target, true);
    removeJ4PrivateTree(target, directory, true);
  }
}

export async function cleanup(state) {
  requireEngineGate();
  setResourceGuard(undefined); // Cleanup must be possible below the disk floor.
  let resources = await inventory(state);
  const plan = cleanupPlan(resources, state);
  let forcedStops = 0;
  for (const resource of plan) {
    const [current] = JSON.parse(await docker([resource.kind, 'inspect', resource.id]));
    cleanupPlan([{ ...resource, labels: current.Config?.Labels ?? current.Labels }], state);
    if (!owns(current.Config?.Labels ?? current.Labels, state)) fail('resource-ownership');
    if (resource.kind === 'container') {
      // Allow the shipped 11-minute worker drain. Observe any actual forced
      // settlement separately; absence does not prove graceful delivery.
      await docker(['stop', '--time', '660', resource.id], { timeout: 700_000 });
      const [stopped] = JSON.parse(await docker(['container', 'inspect', resource.id]));
      if (current.State?.Running && (stopped.State?.ExitCode === 137 || stopped.State?.OOMKilled)) forcedStops++;
      await docker(['rm', '-v', resource.id]);
    } else if (resource.kind === 'image') {
      // Removing exact owned references avoids globally pruning shared bases/cache.
      for (const reference of [...(current.RepoTags ?? []), ...(current.RepoDigests ?? [])]) {
        if ((await inventory(state)).some(value => value.kind === 'image' && value.id === resource.id
          && [...(value.item.RepoTags ?? []), ...(value.item.RepoDigests ?? [])].includes(reference))) await docker(['image', 'rm', reference]);
      }
      const left = (await inventory(state)).find(value => value.kind === 'image' && value.id === resource.id);
      if (left) await docker(['image', 'rm', resource.id]);
    } else await docker([resource.kind, 'rm', resource.id]);
  }
  resources = await inventory(state);
  if (resources.length) fail('owned-resources-remain');
  const receipt = { schemaVersion: 1, kind: 'local_engine', ownedResourcesRemaining: 0, removed: plan.length, forcedStops, productionReady: false };
  save(path.join(state.directory, 'cleanup.receipt.json'), receipt);
  cleanupJ4PrivateMaterials(state);
  // Private receipts and digest inventories remain reviewable. Remove owned
  // credentials, scratch configuration and database dumps only after absence.
  for (const name of fs.readdirSync(state.directory)) {
    if (!['tls', 'installation', 'worker-peer', 'supabase-project', 'input.json'].includes(name) && !name.endsWith('.env') && !name.endsWith('.backup.sql')) continue;
    const target = privateLocation(path.join(state.directory, name));
    if (!target.startsWith(`${state.directory}${path.sep}`)) fail('cleanup-private-path');
    fs.rmSync(target, { recursive: true, force: true });
  }
  return receipt;
}

export async function cli(main) {
  try { await main(); }
  catch (error) {
    const id = error instanceof Error && /^default-stack:[A-Za-z0-9._-]+$/.test(error.message) ? error.message : 'default-stack:failed';
    if (id === 'default-stack:requires-ZENITH_ACCEPTANCE_DEFAULT_STACK') {
      process.stdout.write(`${JSON.stringify({ status: 'not-run', reason: id, passed: 0, failed: 0, skipped: 1 })}\n`); process.exitCode = 77;
    } else { process.stderr.write(`${id}\n`); process.exitCode = 1; }
  }
}
