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
L = R / 'logs/cleanup-corrections-native-root-r1-20261005'
parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--source-sha256', required=True)
args = parser.parse_args()
source_path = pathlib.Path(args.source)
assert hashlib.sha256(source_path.read_bytes()).hexdigest() == args.source_sha256
source = json.loads(source_path.read_text())
assert source['worktree'] == str(W) and source['status'] == 'ROOT_IMPORTED_ACCEPTED_SOURCE_ONLY_ACTUAL_CHECKS_PENDING'
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
assert index_hash == source['realIndexSha256']
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=W, env=E, text=True).strip()
assert head == source['baseHead'] == 'f69965600bc47e5f2935e19bdb10a2225d595fc5'
assert (W / 'node_modules').is_symlink() and (W / 'node_modules').resolve() == (R / 'checkouts/production-f699656-20261005/node_modules').resolve()
case_path = R / 'logs/cleanup-writer-gates-r2-20261005/revision2/CASE-CONTRACT.json'
assert hashlib.sha256(case_path.read_bytes()).hexdigest() == '76a9670ca917fbe5525631ce7db42e143889b66003ff945c6d1f4be94f8f89ef'
case = json.loads(case_path.read_text())
assert before[case['file']] == '4709e75f33820dc62e9b9a9be870d1cf71d94092cbaa1063257790e1db069ae9'
assert len(case['cases']) == len(set(case['cases'])) == 46
assert hashlib.sha256(('\n'.join(case['cases']) + '\n').encode()).hexdigest() == case['orderedNamesSha256']
image = 'postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
owner = secrets.token_hex(16)
name = 'zenith-cleanup-workflow-' + owner[:12]
baseline = set(subprocess.check_output(['docker', 'image', 'ls', '--quiet', '--no-trunc'], text=True).split())
iid = None
started = False
assert shutil.disk_usage(R).free >= 12 * 1024 ** 3
record = {'status': 'running', 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceReceipt': {'path': str(source_path), 'sha256': args.source_sha256}, 'sourceFingerprint': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(), 'worktree': str(W), 'head': head, 'candidateTree': source['candidateTree'], 'caseContract': str(case_path), 'caseCount': 46, 'scope': 'Actual local PostgreSQL and Temporal; cleanup default coordinator/broker/paired codec. Hosted product/topology, policy and provider protocols remain modeled. No raw provider apply, provider quiescence/settlement, hosted TLS/pooler or default API proof. Cohorts overlap and are never summed.', 'steps': [], 'container': name, 'owner': owner, 'lanes': {}}
redactions = []

def save():
    (L / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')

def unchanged():
    return before == inventory() and index_hash == hashlib.sha256(index_path.read_bytes()).hexdigest() and head == subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=W, env=E, text=True).strip()

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
    rows = [x for x in data['testResults'] if x['name'] == str(W / case['file'])]
    assert len(rows) == 1
    rows = rows[0]['assertionResults']
    assert [x['title'] for x in rows] == case['cases']
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
        run('platform15-fresh', ['bash', 'scripts/ci/apply-platform-migrations.sh'], pe)
        run('platform15-reapply', ['bash', 'scripts/ci/apply-platform-migrations.sh'], pe)
        run('agent3-reapply', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/agent/apply-schema.ts'], pe)
        run('agent-canonical-verifier', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/agent/verify-schema.ts'], {**pe, 'SUPABASE_DB_URL': platform_url})
        run('supabase17-fresh', ['bash', 'scripts/ci/apply-supabase-migrations.sh'])
        run('supabase17-reapply', ['bash', 'scripts/ci/apply-supabase-migrations.sh'])
        files = ["tests/capabilities/destroy-propose.test.ts", "tests/execution/destroy-review.test.ts", "tests/capabilities/store-contract.test.ts", "tests/capabilities/tenancy.test.ts", "tests/controlplane/grants.test.ts", "tests/controlplane/migrations.test.ts", "tests/controlplane/plan-artifact-retention.test.ts", "tests/controlplane/services.test.ts", "tests/controlplane/cleanup-writer-barriers.test.ts"]
        flags = {**pe, "SUPABASE_DB_URL": "", "ZENITH_CONTRACT_POSTGRES": "1", "ZENITH_TEST_PLAN_RETENTION_REQUIRED": "1", "ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED": "1"}
        run("lint-corrections", ["node", "node_modules/eslint/bin/eslint.js", "src/lib/capabilities/execution.ts", *files])
        report = L / "corrections.json"
        run("native-corrections", ["node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", "--no-file-parallelism", *files, "--reporter=default", "--reporter=json", "--outputFile.json=" + str(report)], flags)
        actual = json.loads(report.read_text())
        assert counts(report)["failed"] == 0 and counts(report)["skipped"] == 0
        rows = [(str(pathlib.Path(row["name"]).relative_to(W)), assertion["fullName"], assertion["status"]) for row in actual["testResults"] for assertion in row["assertionResults"]]
        assert len(rows) == len(set((f, n) for f, n, status in rows)), "Duplicate current native identity"
        expected = []
        for relative, expected_sha in [("logs/cleanup-schema-fixtures-20261005/revision1/CASE-CONTRACT.json", "e6d2ff4ca63513ce9b5634c88a58c19edf8e408a2286537cd082d28519e666b6"), ("logs/cleanup-dispatch-corrections-20261005/revision1/CASE-CONTRACT.json", "dfb27ef67f40c5243db68b36ac4d76f5a9388b257914eea13b4521a7bc5101dc")]:
            cp = R / relative
            assert hashlib.sha256(cp.read_bytes()).hexdigest() == expected_sha
            contract = json.loads(cp.read_text())
            expected += [(x["path"], x["name"]) for x in contract["cases"]]
        assert len(expected) == len(set(expected)) == 258
        assert all((f, n, "passed") in rows for f, n in expected), "Required existing correction case missing or not passed"
        exact_cleanup(report)
        assert len(rows) == 304
        record["targetedNative"] = {"counts": counts(report), "requiredCorrectionCases": 258, "requiredCleanupCases": 46, "report": str(report), "sha256": hashlib.sha256(report.read_bytes()).hexdigest(), "scope": "Actual PostgreSQL16.15, PGlite/model and default paired cleanup metadata checks, all existing304 cases. Hosted/current policy/provider protocols remain explicitly modeled; no provider settlement/default API/cloud acceptance."}
        record['sourceUnchanged'] = unchanged()
        assert record['sourceUnchanged']
        record['status'] = 'passed_native_pending_owned_cleanup'
        save()
except BaseException:
    record['status'] = 'failed'
    record['failurePhase'] = record['steps'][-1]['name'] if record['steps'] else 'setup'
    record['sourceUnchanged'] = unchanged()
    for label in ['corrections']:
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
        record['status'] = 'passed_actual_targeted_native_corrections_only'
    save()
