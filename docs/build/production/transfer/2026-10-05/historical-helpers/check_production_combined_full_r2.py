import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path('/Users/saivedanthava/.codex/zenith-production')
OLD = Path('/Users/saivedanthava/.codex/zenith-w8')
CWD = Path(sys.argv[1])
LABEL = sys.argv[2]
LOGS = ROOT / 'logs'
env = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'AZURE_', 'GOOGLE_', 'OCI_', 'SUPABASE_', 'NEXT_PUBLIC_SUPABASE_', 'ZENITH_', 'KUBECONFIG', 'OPENAI_', 'ANTHROPIC_')) and k not in ('GH_TOKEN','GITHUB_TOKEN','NPM_TOKEN','NODE_AUTH_TOKEN')}
env.update(GOMAXPROCS='2', GOFLAGS='-p=2', PATH=str(OLD / 'tools/node-current/bin') + ':' + str(OLD / 'tools/go/bin') + ':' + str(OLD / 'tools') + ':' + env['PATH'],
    GOTOOLCHAIN='local', NODE_OPTIONS='--max-old-space-size=4096', npm_config_yes='false',
    ZENITH_TOFU_BIN=str(OLD / 'tools/tofu'), ZENITH_TEST_TOFU=str(OLD / 'tools/tofu'), ZENITH_TEST_TOFU_NETWORK='1',
    ZENITH_OPA_BIN=str(OLD / 'tools/opa'), ZENITH_TOFU_PLUGIN_CACHE=str(OLD / 'tofu-plugin-cache'), TF_PLUGIN_CACHE_DIR=str(OLD / 'tofu-plugin-cache'),
    TF_REGISTRY_CLIENT_TIMEOUT='60', ZENITH_TEST_TEMPORAL_SERVER=str(OLD / 'tools/temporal-test-server'),
    ZENITH_TEST_TEMPORAL_CLI=str(ROOT / 'tools/temporal-cli-1.9.1/temporal'))
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CWD, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=CWD, text=True).strip():
    raise SystemExit('Full gate requires clean source')
record = {'commit': sha, 'tree': subprocess.check_output(['git', 'write-tree'], cwd=CWD, text=True).strip(), 'cleanInstallationReceipt': str(LOGS / 'production-upload-cost-clean-install-r2-20261005/receipt.json'), 'status': 'running', 'steps': [], 'unexecuted': [
    'Local API server Smoke/Gimbal require still-pending local startup authorization. Exact pushed CI runs browser gates.',
    'Real PostgreSQL/Supabase lanes run separately after this serialized gate.',
    'External Temporal mTLS, live clouds and operational release acceptance remain separate blockers.']}

def save():
    p = LOGS / (LABEL + '-results.json')
    p.write_text(json.dumps(record, indent=2) + '\n')
    p.chmod(0o600)

with tempfile.TemporaryDirectory(prefix='zenith-owned-full-gate-') as directory:
    env['ZENITH_DATA'] = directory
    manifest = json.loads(subprocess.check_output(['node', 'scripts/ci/gate-manifest.mjs', 'core'], cwd=CWD, env=env, text=True))
    unit = next(s['command'] for s in manifest['steps'] if s['id'] == 'unit')
    unit += ['--reporter=default', '--reporter=json', '--outputFile.json=' + str(LOGS / (LABEL + '-unit.json'))]
    steps = [
        ('typecheck', ['npm', 'run', 'typecheck']), ('lint', ['npm', 'run', 'lint']),
        ('gofmt', ['go', 'fmt', '-n', './...']), ('go-vet', ['go', 'vet', './...']), ('go-race', ['go', 'test', '-race', '-json', './...']),
        ('policy-generated', ['npm', 'run', 'policy:check']), ('emit-sql', ['npm', 'run', 'platform:emit-sql', '--', '--check']),
        ('matrix', ['node_modules/.bin/tsx', 'scripts/docs/capability-matrix.ts', '--strict']),
        ('aws-templates', ['node_modules/.bin/tsx', 'deploy/aws/tools/generate-tofu-policies.ts', '--check']),
        ('ledger', ['node', 'scripts/build/production-ledger.mjs', '--check']),
        ('unit', unit), ('security', ['node', 'scripts/ci/security-audit.mjs']),
    ]
    # gofmt remains read-only; go fmt -n is a tool dry run whose output is inspected.
    steps[2] = ('gofmt', ['gofmt', '-l', '.'])
    for lane in ['workflows', 'policy', 'tofu']:
        report = str(LOGS / (LABEL + '-' + lane + '.json'))
        evidence = str(LOGS / (LABEL + '-' + lane + '-evidence.json'))
        steps.extend([(lane, ['node', 'scripts/ci/run-gate.mjs', lane, '--run', '--report', report, '--evidence', evidence]),
            (lane + '-revalidate', ['node', 'scripts/ci/run-gate.mjs', lane, '--validate', report, '--require-execution', '--evidence', evidence])])
    for name, command in steps:
        print('START ' + name, flush=True)
        start = time.monotonic()
        log = LOGS / (LABEL + '-' + name + '.log')
        with log.open('w') as stream:
            log.chmod(0o600)
            result = subprocess.Popen(command, cwd=CWD / 'go' if name.startswith('go') else CWD, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            while result.poll() is None:
                if shutil.disk_usage(CWD).free < 8 * 1024**3:
                    os.killpg(result.pid, signal.SIGTERM)
                    result.wait(timeout=30)
                    record['status'] = 'failed_storage_floor'
                    save()
                    raise RuntimeError('Owned full gate stopped at8GiB storage floor')
                time.sleep(1)
        code = result.returncode
        if name == 'gofmt' and log.read_text().strip():
            code = 1
        row = {'name': name, 'exitCode': code, 'seconds': round(time.monotonic() - start, 2), 'log': str(log)}
        report_path = LOGS / (LABEL + '-' + name + '.json')
        if name in ['unit', 'workflows', 'policy', 'tofu'] and report_path.exists():
            report = json.loads(report_path.read_text())
            row['counts'] = {key: report.get('num' + count + 'Tests') for key, count in [('passed', 'Passed'), ('failed', 'Failed'), ('skipped', 'Pending'), ('total', 'Total')]}
            if row['counts']['passed'] is None or row['counts']['passed'] <= 0 or row['counts']['failed'] != 0:
                code = 1
                row['exitCode'] = 1
        record['steps'].append(row)
        save()
        print('END ' + name + ' exit=' + str(code) + ' seconds=' + str(row['seconds']) + (' counts=' + json.dumps(row['counts']) if 'counts' in row else ''), flush=True)
        if code:
            record['status'] = 'failed'
            save()
            raise SystemExit(code)
    record['status'] = 'passed_executed_gates_only'
    save()
    print('FULL EXECUTED GATES COMPLETE; separate gates remain listed', flush=True)
