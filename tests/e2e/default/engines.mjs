import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { docker, ensure, until, browserRequest, ok, sha256 } from './support.mjs';

export class Machine {
  constructor(config, stack, runId) {
    this.config = config; this.stack = stack; this.runId = runId;
    this.container = 'zenith-j2-' + runId;
    this.volumes = [this.container + '-witness', this.container + '-state'];
    this.credential = randomBytes(32).toString('base64url');
    this.created = [];
  }
  async start(token, environmentId, address) {
    for (const volume of this.volumes) {
      await docker(['volume', 'create', '--label', 'io.zenith.journey=' + this.runId, volume]);
      this.created.push({ kind: 'volume', id: volume });
    }
    const config = { controlPlane: { url: 'http://127.0.0.1:3400' }, name: this.container,
      stateDir: '/var/lib/zenithd', registration: { tokenFile: '/witness/registration-token' },
      exec: { enabled: true, allowArgv0: ['/usr/local/bin/witness'] },
      heartbeatSec: 2, pollWaitSec: 2, maxConcurrent: 1,
      labels: { 'zenith.credentialMode': 'local_only' } };
    await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--user', '0:0', '--memory', '64m', '--pids-limit', '32',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      this.config.machine.image, 'seed'],
      { input: JSON.stringify({ config, token, credential: this.credential }) });
    await docker(['run', '-d', '--name', this.container, '--label', 'io.zenith.journey=' + this.runId,
      // Go accepts loopback HTTP only. Share the owned API's network namespace,
      // without a host network, Docker socket, privileged mode or TLS bypass.
      '--network', 'container:' + this.stack.api, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '64',
      '--mount', 'type=volume,source=' + this.volumes[0] + ',target=/witness',
      '--mount', 'type=volume,source=' + this.volumes[1] + ',target=/var/lib/zenithd',
      '--entrypoint', '/usr/local/bin/zenithd', this.config.machine.image, 'run', '--config', '/witness/config.json']);
    this.created.push({ kind: 'container', id: this.container });
    this.environmentId = environmentId; this.address = address;
  }
  async registered(page, workspaceId) {
    const data = await until(async () => ok(await browserRequest(page, '/api/platform/v1/machines', undefined, 'GET', workspaceId)),
      value => value.machines?.some(machine => machine.name === this.container && machine.connection?.state === 'online'));
    const machine = data.machines.find(machine => machine.name === this.container);
    ensure(machine.environmentId === this.environmentId && machine.address === this.address, 'machine-consent-binding');
    this.id = machine.id; return machine;
  }
  async read(expectedNonce) {
    const read = await docker(['exec', this.container, '/usr/local/bin/witness', 'read']);
    const data = JSON.parse(read);
    ensure(data.nonce === expectedNonce && data.kind === 'zenith-default-journey', 'machine-independent-readback');
    return sha256(data);
  }
  async credentialAbsent(scratch) {
    // Scan the CP containers' environment and durable application directories on
    // the HOST. Never send the local credential to a CP process or model.
    const inspect = await docker(['inspect', this.stack.api, this.stack.worker]);
    ensure(!inspect.includes(this.credential), 'credential-in-cp-environment');
    // J1 proves product and authority share this owned local PostgreSQL engine.
    // Export through its existing local admin socket, never pass the canary to
    // SQL/the CP, and inspect the bounded logical dump only in host memory.
    const database = 'supabase_db_' + this.stack.state.projectId;
    const [db] = JSON.parse(await docker(['inspect', database]));
    ensure(db.Config.Labels?.['com.supabase.cli.project'] === this.stack.state.projectId &&
      db.Config.Labels?.['io.zenith.installation'] === this.stack.state.installationId, 'cp-database-ownership');
    const dump = await docker(['exec', database, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=plain'],
      { maxBytes: 64 * 1024 * 1024, timeout: 120_000 });
    ensure(dump.includes('CREATE SCHEMA platform;'), 'cp-logical-dump-empty');
    ensure(!dump.includes(this.credential), 'credential-in-cp-database');
    for (const [id, directory] of [[this.stack.api, '/data'], [this.stack.worker, '/var/lib/zenith']]) {
      const destination = path.join(scratch, id.slice(0, 12));
      fs.mkdirSync(destination, { mode: 0o700 });
      await docker(['cp', id + ':' + directory + '/.', destination], { maxBytes: 1024 });
      let bytes = 0;
      const walk = folder => {
        for (const name of fs.readdirSync(folder)) {
          const file = path.join(folder, name), stat = fs.lstatSync(file);
          ensure(!stat.isSymbolicLink(), 'cp-scan-symlink');
          if (stat.isDirectory()) walk(file);
          else if (stat.isFile()) {
            bytes += stat.size;
            ensure(bytes <= 64 * 1024 * 1024, 'cp-scan-bound');
            ensure(!fs.readFileSync(file).includes(Buffer.from(this.credential)), 'credential-in-cp-file');
          }
        }
      };
      try { walk(destination); } finally { fs.rmSync(destination, { recursive: true, force: true }); }
    }
  }
  async cleanup() {
    for (const resource of [...this.created].reverse()) {
      const [current] = JSON.parse(await docker([resource.kind, 'inspect', resource.id]));
      const labels = resource.kind === 'container' ? current.Config.Labels : current.Labels;
      ensure(labels?.['io.zenith.journey'] === this.runId, 'cleanup-ownership');
      if (resource.kind === 'container') {
        await docker(['stop', '--time', '10', resource.id]);
        await docker(['rm', resource.id]);
      } else await docker(['volume', 'rm', resource.id]);
    }
  }
}
