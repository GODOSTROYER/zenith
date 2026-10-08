import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, docker, ensure, localUrl } from './support.mjs';

export async function prepare(args) {
  if (process.env.ZENITH_DEFAULT_JOURNEY !== '1') return { status: 'skipped' };
  ensure(process.platform === 'darwin' && process.arch === 'arm64', 'native-mac-required');
  const values = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    ensure(['--directory', '--stack', '--node-image', '--witness-image', '--mailpit-url'].includes(key) && value && !values[key], 'prepare-usage');
    values[key] = value;
  }
  ensure(Object.keys(values).length === 5, 'prepare-usage');
  const directory = path.resolve(values['--directory']), root = process.cwd();
  ensure(!fs.existsSync(directory) && !directory.startsWith(root + path.sep) && directory !== root &&
    fs.realpathSync(path.dirname(directory)) === path.dirname(directory), 'prepare-private-directory');
  for (const key of ['--node-image', '--witness-image']) ensure(/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(values[key]), 'prepare-image-digest');
  ensure(/^localhost:5000\/zenith-j2-witness@sha256:[a-f0-9]{64}$/.test(values['--witness-image']), 'local-witness-image');
  localUrl(values['--mailpit-url']);
  const clusters = await command('kind', ['get', 'clusters']);
  ensure(!clusters.split(/\s+/).includes('zenith-j2'), 'kind-name-already-owned');
  const runtime = await import(pathToFileURL(path.resolve('scripts/acceptance/default-stack/runtime.mjs')).href);
  const stackDirectory = fs.realpathSync(values['--stack']);
  const state = runtime.readState(stackDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });
  const save = (name, data) => fs.writeFileSync(path.join(directory, name), data, { mode: 0o600, flag: 'wx' });
  save('kind.yaml', 'kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnetworking:\n  apiServerAddress: 127.0.0.1\nnodes:\n- role: control-plane\n');
  // Record cleanup responsibility before starting any target.
  save('targets.json', JSON.stringify({ schemaVersion: 1, kind: 'zenith-j2', createdBy: 'J2-DEFAULT-JOURNEY', status: 'preparing' }));
  const bootstrap = path.join(directory, 'kind-bootstrap.yaml');
  await command('kind', ['create', 'cluster', '--name', 'zenith-j2', '--image', values['--node-image'],
    '--config', path.join(directory, 'kind.yaml'), '--kubeconfig', bootstrap, '--wait', '180s'], { timeout: 240_000 });
  fs.chmodSync(bootstrap, 0o600);
  const [node] = JSON.parse(await docker(['inspect', 'zenith-j2-control-plane']));
  ensure(node.Config.Labels?.['io.x-k8s.kind.cluster'] === 'zenith-j2', 'kind-ownership');
  fs.writeFileSync(path.join(directory, 'targets.json'), JSON.stringify({ schemaVersion: 1, kind: 'zenith-j2',
    createdBy: 'J2-DEFAULT-JOURNEY', status: 'created', containerId: node.Id }), { mode: 0o600 });
  const [kindImage] = JSON.parse(await docker(['image', 'inspect', node.Image]));
  ensure(kindImage.Architecture === 'arm64', 'kind-native-arm64');
  await docker(['update', '--memory', '640m', '--memory-swap', '1g', '--cpus', '1', node.Id]);
  const api = (await runtime.compose(state, ['ps', '-q', 'api'])).trim();
  const [apiContainer] = JSON.parse(await docker(['inspect', api]));
  const network = Object.keys(apiContainer.NetworkSettings.Networks).find(name => name === state.applicationProjectName + '_installation');
  ensure(network, 'j1-network');
  await docker(['network', 'connect', '--alias', 'zenith-j2-control-plane', network, node.Id]);
  const image = JSON.parse(await docker(['image', 'inspect', values['--witness-image']]))[0];
  ensure(image.Architecture === 'arm64', 'witness-native-arm64');
  const tag = image.RepoTags?.find(value => /^localhost:5000\/zenith-j2-witness:[a-z0-9._-]+$/.test(value));
  ensure(tag, 'witness-local-tag');
  const archive = path.join(directory, 'witness.tar');
  await docker(['image', 'save', '--output', archive, tag]); fs.chmodSync(archive, 0o600);
  await command('kind', ['load', 'image-archive', '--name', 'zenith-j2', archive], { timeout: 120_000 });
  await docker(['exec', node.Id, 'ctr', '--namespace=k8s.io', 'images', 'tag', '--force', tag, values['--witness-image']]);
  fs.unlinkSync(archive);
  const observer = path.join(directory, 'observer.json');
  // Independent observer is exported only from this new local kind cluster.
  save('observer.json', await command('kind', ['get', 'kubeconfig', '--name', 'zenith-j2']));
  const kubectl = args => command('kubectl', ['--kubeconfig', observer, '--context', 'kind-zenith-j2', ...args]);
  const manifest = {
    apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'zenith-j2' } },
      ...['old', 'new'].flatMap(epoch => [
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'j2-deployer-' + epoch, namespace: 'zenith-j2' } },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
          metadata: { name: 'j2-deployer-' + epoch, namespace: 'zenith-j2' },
          subjects: [{ kind: 'ServiceAccount', name: 'j2-deployer-' + epoch, namespace: 'zenith-j2' }],
          roleRef: { kind: 'Role', name: 'j2-deployer', apiGroup: 'rbac.authorization.k8s.io' } },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
          metadata: { name: 'j2-namespace-' + epoch }, subjects: [{ kind: 'ServiceAccount', name: 'j2-deployer-' + epoch, namespace: 'zenith-j2' }],
          roleRef: { kind: 'ClusterRole', name: 'j2-namespace', apiGroup: 'rbac.authorization.k8s.io' } },
      ]),
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'j2-deployer', namespace: 'zenith-j2' },
        rules: [{ apiGroups: ['', 'apps', 'networking.k8s.io', 'batch', 'policy'], resources: ['*'], verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'] }] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'j2-namespace' },
        rules: [{ apiGroups: [''], resources: ['namespaces'], resourceNames: ['zenith-j2'], verbs: ['get', 'patch', 'update'] }] },
    ],
  };
  save('rbac.json', JSON.stringify(manifest));
  await kubectl(['apply', '-f', path.join(directory, 'rbac.json')]);
  const flattened = JSON.parse(await kubectl(['config', 'view', '--raw', '--flatten', '-o', 'json']));
  const caData = flattened.clusters[0].cluster['certificate-authority-data'];
  ensure(typeof caData === 'string', 'kind-ca');
  for (const epoch of ['old', 'new']) {
    const token = await kubectl(['-n', 'zenith-j2', 'create', 'token', 'j2-deployer-' + epoch, '--duration=1h']);
    ensure(token.length > 0, 'kind-token');
    save('deployer-' + epoch + '.json', JSON.stringify({ apiVersion: 'v1', kind: 'Config',
      'current-context': 'kind-zenith-j2', contexts: [{ name: 'kind-zenith-j2', context: { cluster: 'zenith-j2', user: 'j2-' + epoch } }],
      clusters: [{ name: 'zenith-j2', cluster: { server: 'https://zenith-j2-control-plane:6443', 'certificate-authority-data': caData } }],
      users: [{ name: 'j2-' + epoch, user: { token } }] }));
  }
  save('journey.json', JSON.stringify({ schemaVersion: 1, stackDirectory, mailpitUrl: values['--mailpit-url'],
    kind: { context: 'kind-zenith-j2', namespace: 'zenith-j2', server: 'https://zenith-j2-control-plane:6443',
      kubeconfigFile: path.join(directory, 'deployer-old.json'), rotationKubeconfigFile: path.join(directory, 'deployer-new.json'),
      observerKubeconfigFile: observer, image: values['--witness-image'] }, machine: { image: values['--witness-image'] } }));
  return { status: 'prepared', productionReady: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('tests/e2e/default/prepare.mjs')) {
  try { process.stdout.write(JSON.stringify(await prepare(process.argv.slice(2))) + '\n'); }
  catch { process.stderr.write('journey:target-preparation-failed; clean only the owned zenith-j2 cluster\n'); process.exitCode = 1; }
}
