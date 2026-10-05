"""Root-only actual PostgreSQL acceptance of the reviewed cleanup/workflow source."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time

R = pathlib.Path('/Users/saivedanthava/.codex/zenith-production')
W = R / 'worktrees/cleanup-native-integration-20261005'
L = R / 'logs/saved-plan-settlement-native-root-r2-20261005'
parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--source-sha256', required=True)
args = parser.parse_args()
source_path = pathlib.Path(args.source)
assert hashlib.sha256(source_path.read_bytes()).hexdigest() == args.source_sha256
source = json.loads(source_path.read_text())
assert source['worktree'] == str(W) and source['status'] == 'ROOT_COMPOSED_SOURCE_ONLY_GATES_AND_RUNTIME_PENDING'
assert not L.exists()
L.mkdir(mode=0o700)
E = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'AZURE_', 'GOOGLE_', 'OCI_', 'SUPABASE_', 'NEXT_PUBLIC_SUPABASE_', 'ZENITH_', 'KUBECONFIG', 'OPENAI_', 'ANTHROPIC_')) and k not in ('GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'PGHOST', 'PGPORT', 'PGPASSWORD', 'PGUSER', 'PGDATABASE')}
E.update(GIT_OPTIONAL_LOCKS='0', PATH='/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:/Users/saivedanthava/.codex/zenith-w8/tools:/opt/homebrew/opt/libpq@16/bin:' + E['PATH'], NODE_OPTIONS='--max-old-space-size=2048', ZENITH_FAST='1', npm_config_yes='false', GOMAXPROCS='2', ZENITH_TEST_TEMPORAL_CLI=str(R / 'tools/temporal-cli-1.9.1/temporal'), ZENITH_TEST_TEMPORAL_SERVER='/Users/saivedanthava/.codex/zenith-w8/tools/temporal-test-server', ZENITH_TOFU_BIN='/Users/saivedanthava/.codex/zenith-w8/tools/tofu', ZENITH_TEST_TOFU='/Users/saivedanthava/.codex/zenith-w8/tools/tofu', ZENITH_TEST_TOFU_NETWORK='1', ZENITH_TOFU_PLUGIN_CACHE='/Users/saivedanthava/.codex/zenith-w8/tofu-plugin-cache', TF_PLUGIN_CACHE_DIR='/Users/saivedanthava/.codex/zenith-w8/tofu-plugin-cache', TF_REGISTRY_CLIENT_TIMEOUT='60', ZENITH_TEST_PG_DUMP_BIN='/opt/homebrew/opt/libpq@16/bin/pg_dump', ZENITH_TEST_PG_RESTORE_BIN='/opt/homebrew/opt/libpq@16/bin/pg_restore')

def inventory():
    names = {x.decode() for x in subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=W, env=E).split(b'\0') if x}
    return {n: hashlib.sha256((W / n).read_bytes()).hexdigest() for n in sorted(names)}

before = inventory()
assert before == source['inventory']
index_path = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--git-path', 'index'], cwd=W, env=E, text=True).strip())
if not index_path.is_absolute():
    index_path = W / index_path
index_hash = hashlib.sha256(index_path.read_bytes()).hexdigest()
stage_hash = hashlib.sha256(subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=W, env=E)).hexdigest()
assert stage_hash == '6bc8d24de22de7465f84d1801a0eab0bc803caa92783e3b9f5079ed09d8ef02a'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=W, env=E, text=True).strip()
assert head == source['head'] == 'f69965600bc47e5f2935e19bdb10a2225d595fc5'
assert (W / 'node_modules').is_symlink() and (W / 'node_modules').resolve() == (R / 'checkouts/production-f699656-20261005/node_modules').resolve()
case_path = R / 'logs/saved-plan-writer-settlement-20261005/revision2/CASE-CONTRACT.json'
assert hashlib.sha256(case_path.read_bytes()).hexdigest() == 'f54f4b81ff2a2e67ebe4c061db1136823a9bd2e9d792323c6abcf9b8b4249e9d'
case = json.loads(case_path.read_text())
case_file = 'tests/controlplane/cleanup-writer-barriers.test.ts'
assert len(case['cases']) == 100 and all(x['file'] == case_file and x['suite'] == case['suite'] and x['postgres'] is True for x in case['cases'])
case_names = [x['test'] for x in case['cases']]
assert len(set(case_names)) == 100
assert hashlib.sha256(json.dumps(case_names, separators=(',', ':')).encode()).hexdigest() == case['orderedNamesSha256']
for path, digest in [('logs/integration-authority-review-20261004/saved-plan-writer-settlement-r2-review-20261005/REVIEW.json','85f82c753e6d95ab3a6363308d3b1756f7d1f1b633ad7431e75c880763f712ad'),('logs/journey-authority-review-20261004/saved-plan-writer-settlement-r2-review-20261005/REVIEW.json','53a0951dec73bc69a1f2fd45aca1ef44181b137f6544609cb7f83ebfffee2eb8')]:
    assert hashlib.sha256((R/path).read_bytes()).hexdigest() == digest
image = 'postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
owner = secrets.token_hex(16)
name = 'zenith-settlement-native-' + owner[:12]
baseline = set(subprocess.check_output(['docker', 'image', 'ls', '--quiet', '--no-trunc'], text=True).split())
iid = None
started = False
assert shutil.disk_usage(R).free >= 12 * 1024 ** 3
record = {'status': 'running', 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceReceipt': {'path': str(source_path), 'sha256': args.source_sha256}, 'sourceFingerprint': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(), 'worktree': str(W), 'head': head, 'candidateTree': source['candidateTree'], 'caseContract': str(case_path), 'caseCount': 100, 'scope': 'Actual PostgreSQL16.15 and pinned OpenTofu for generated builtin/local saved-plan settlement and cleanup controls. Hosted product association/policy explicitly modeled. No Temporal or Supabase lane, cloud/provider settlement, default API, TLS/pooler or full combined acceptance.', 'steps': [], 'container': name, 'owner': owner, 'lanes': {}}
redactions = []

def save():
    (L / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')

def unchanged():
    return before == inventory() and stage_hash == hashlib.sha256(subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=W, env=E)).hexdigest() and head == subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=W, env=E, text=True).strip()

def run(stage, command, extra=None, expected=0):
    assert unchanged(), 'Root acceptance source or index changed'
    print('START ' + stage, flush=True)
    path = L / (stage + '.log')
    now = time.monotonic()
    with path.open('w') as output:
        path.chmod(0o600)
        child = subprocess.Popen(command, cwd=W, env={**E, **(extra or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', start_new_session=True)
        def copy_sanitized():
            for line in child.stdout:
                for sensitive in redactions:
                    line = line.replace(sensitive, '[REDACTED_OWNED_EPHEMERAL_CREDENTIAL]')
                output.write(line)
            output.flush()
        reader = threading.Thread(target=copy_sanitized, daemon=True)
        reader.start()
        while child.poll() is None:
            if shutil.disk_usage(R).free < 8 * 1024 ** 3:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                raise RuntimeError('Owned runtime stopped at 8 GiB storage reserve')
            time.sleep(1)
        reader.join(timeout=30)
        assert not reader.is_alive(), 'Runtime log drain incomplete'
    record['steps'].append({'name': stage, 'exitCode': child.returncode, 'expectedExitCode': expected, 'seconds': round(time.monotonic() - now, 2), 'log': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    save()
    print('END ' + stage + ' exit=' + str(child.returncode), flush=True)
    if child.returncode != expected:
        raise RuntimeError('Owned native phase failed: ' + stage)

def counts(report):
    data = json.loads(report.read_text())
    return {k: data.get('num' + v + 'Tests') for k, v in [('passed', 'Passed'), ('failed', 'Failed'), ('skipped', 'Pending'), ('total', 'Total')]}

def exact_cleanup(report):
    data = json.loads(report.read_text())
    rows = [x for x in data['testResults'] if x['name'] == str(W / case_file)]
    assert len(rows) == 1
    rows = rows[0]['assertionResults']
    assert [x['title'] for x in rows] == case_names
    assert all(x['status'] == 'passed' and x['ancestorTitles'] == [case['suite']] for x in rows)

def lane(lane_name, expected_count, extra):
    manifest = json.loads(subprocess.check_output(['node', 'scripts/ci/gate-manifest.mjs', lane_name], cwd=W, env={**E, **extra}, text=True))
    assert len(manifest['requirements']) == expected_count
    ids = [x['id'] for x in manifest['requirements']]
    assert len(set(ids)) == expected_count
    report = L / (lane_name + '.json')
    evidence = L / (lane_name + '-evidence.json')
    run('canonical-' + lane_name, ['node', 'scripts/ci/run-gate.mjs', lane_name, '--run', '--report', str(report), '--evidence', str(evidence)], extra)
    run('revalidate-' + lane_name, ['node', 'scripts/ci/run-gate.mjs', lane_name, '--validate', str(report), '--require-execution', '--evidence', str(evidence)], extra)
    record['lanes'][lane_name] = {'counts': counts(report), 'requiredCount': expected_count, 'requiredIdsSha256': hashlib.sha256(json.dumps(sorted(ids), separators=(',', ':')).encode()).hexdigest(), 'report': str(report), 'sha256': hashlib.sha256(report.read_bytes()).hexdigest(), 'evidence': str(evidence), 'scope': record['scope']}
    save()

try:
    with tempfile.TemporaryDirectory(prefix='zenith-cleanup-workflow-') as td:
        pw = secrets.token_urlsafe(28)
        redactions.append(pw)
        envfile = pathlib.Path(td) / 'pg.env'
        envfile.write_text('POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=' + pw + '\nPOSTGRES_DB=zenith_ci\n')
        envfile.chmod(0o600)
        run('pull', ['docker', 'pull', image])
        iid = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], text=True).strip()
        run('start', ['docker', 'run', '--detach', '--name', name, '--label', 'zenith.cleanup.acceptance.owner=' + owner, '--cpus', '2', '--memory', '2g', '--pids-limit', '256', '--env-file', str(envfile), '-p', '127.0.0.1::5432', image])
        started = True
        envfile.unlink()
        port = subprocess.check_output(['docker', 'port', name, '5432/tcp'], text=True).strip().rsplit(':', 1)[1]
        supabase_url = 'postgresql://postgres:' + pw + '@127.0.0.1:' + port + '/zenith_ci'
        platform_url = 'postgresql://postgres:' + pw + '@127.0.0.1:' + port + '/zenith_platform_ci'
        redactions[:0] = [platform_url, supabase_url]
        E.update(PGHOST='127.0.0.1', PGPORT=port, PGUSER='postgres', PGPASSWORD=pw, PGDATABASE='zenith_ci', SUPABASE_DB_URL=supabase_url, ZENITH_DATA=str(pathlib.Path(td) / 'data'))
        for _ in range(60):
            if subprocess.run(['psql', '-qAt', '-c', 'select 1'], env=E, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Owned PostgreSQL readiness failed')
        run('server-version', ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', "do $$ begin if current_setting('server_version') <> '16.15' then raise exception 'Actual server version mismatch'; end if; end $$"])
        run('create-platform-database', ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'create database zenith_platform_ci'])
        pe = {'ZENITH_TEST_PLATFORM_PG_URL': platform_url, 'PGDATABASE': 'zenith_platform_ci'}
        run('agent3-fresh', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/agent/apply-schema.ts'], pe)
        run('platform16-fresh', ['bash', 'scripts/ci/apply-platform-migrations.sh'], pe)
        run('platform16-reapply', ['bash', 'scripts/ci/apply-platform-migrations.sh'], pe)
        run('agent3-reapply', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/agent/apply-schema.ts'], pe)
        run('agent-canonical-verifier', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/agent/verify-schema.ts'], {**pe, 'SUPABASE_DB_URL': platform_url})
        files = [case_file]
        flags = {**pe, 'SUPABASE_DB_URL':'', 'ZENITH_CONTRACT_POSTGRES':'1', 'ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED':'1', 'ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED':'1'}
        run('lint-settlement', ['node','node_modules/eslint/bin/eslint.js','src/lib/tofu/engine.ts','src/lib/tofu/runner.ts','src/lib/platform/plan-artifacts.ts','src/lib/controlplane/db/repos/plan-artifacts.ts','src/lib/controlplane/db/repos/cleanup-writer-barriers.ts','src/lib/controlplane/db/migrations/0016_cleanup_writer_settlements.ts',*files])
        report = L / 'settlement.json'
        run('native-settlement100',['node','node_modules/vitest/vitest.mjs','run','--maxWorkers=1','--no-file-parallelism',*files,'--reporter=default','--reporter=json','--outputFile.json='+str(report)],flags)
        exact_cleanup(report)
        assert counts(report)=={'passed':100,'failed':0,'skipped':0,'total':100}
        record['targetedNative']={'counts':counts(report),'requiredRetainedCases':46,'requiredAdditiveCases':54,'report':str(report),'sha256':hashlib.sha256(report.read_bytes()).hexdigest(),'scope':record['scope']}
        record['rawIndexObservedUnchanged']=index_hash==hashlib.sha256(index_path.read_bytes()).hexdigest()
        record['stagedEntriesUnchanged']=True
        record['sourceUnchanged'] = unchanged()
        assert record['sourceUnchanged']
        record['status'] = 'passed_native_pending_owned_cleanup'
        save()
except BaseException:
    record['status'] = 'failed'
    record['failurePhase'] = record['steps'][-1]['name'] if record['steps'] else 'setup'
    record['sourceUnchanged'] = unchanged()
    for label in ['settlement']:
        report = L / (label + '.json')
        if report.exists():
            record.setdefault('observedReports', {})[label] = {'counts': counts(report), 'sha256': hashlib.sha256(report.read_bytes()).hexdigest(), 'report': str(report)}
    save()
    raise
finally:
    inspection = subprocess.run(['docker', 'container', 'inspect', name], capture_output=True, text=True, timeout=30)
    if inspection.returncode == 0:
        inspected = json.loads(inspection.stdout)[0]
        assert inspected['Config']['Labels']['zenith.cleanup.acceptance.owner'] == owner and inspected['Image'] == iid
        subprocess.run(['docker', 'rm', '--force', '--volumes', name], stdout=subprocess.DEVNULL, check=True)
        record['ownedContainerAbsent'] = subprocess.run(['docker', 'container', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
        assert record['ownedContainerAbsent'], 'Owned database container cleanup failed'
    elif started:
        raise RuntimeError('Started database ownership could not be verified during cleanup')
    if iid and iid not in baseline:
        refs = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'ancestor=' + iid], text=True).strip()
        assert not refs, 'New test image acquired an unrelated reference'
        subprocess.run(['docker', 'image', 'rm', iid], stdout=subprocess.DEVNULL, check=True)
        record['newImageRemoved'] = True
    record['baselineImagesPreserved'] = baseline.issubset(set(subprocess.check_output(['docker', 'image', 'ls', '--quiet', '--no-trunc'], text=True).split()))
    assert record['baselineImagesPreserved'], 'Unrelated baseline image disappeared'
    record['afterFreeGiB'] = round(shutil.disk_usage(R).free / 1024 ** 3, 2)
    if record['status'] == 'passed_native_pending_owned_cleanup':
        assert record.get('ownedContainerAbsent') is True
        assert iid in baseline or record.get('newImageRemoved') is True
        record['status'] = 'passed_actual_targeted_native_settlement100_only'
    save()
