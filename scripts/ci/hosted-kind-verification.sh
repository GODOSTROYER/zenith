#!/usr/bin/env bash
# Run existing gated suites on a fresh GitHub-hosted VM, never on the user's Mac.
set -euo pipefail
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || ${RUNNER_OS:-} != Linux || ${RUNNER_ARCH:-} != X64 ]]; then
  echo 'This disposable gate requires a standard GitHub-hosted Linux X64 runner.' >&2
  exit 2
fi
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
[[ $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]]
root=$(git rev-parse --show-toplevel)
cd "$root"
git diff --quiet && git diff --cached --quiet
export ZENITH_KIND_TESTED_SOURCE
ZENITH_KIND_TESTED_SOURCE=$(git rev-parse HEAD)
work=$(mktemp -d "$RUNNER_TEMP/zenith-hosted-kind.XXXXXX")
chmod 700 "$work"
output="$RUNNER_TEMP/zenith-hosted-kind-result.json"
rm -f -- "$output"
cluster="zenith-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
owned=0
export ZENITH_KIND_TEST_EXIT=127 ZENITH_KIND_VERSION_MATCHED=0
export ZENITH_KIND_NODE_IMAGE='kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
export ZENITH_TEST_KIND=1 ZENITH_TEST_KIND_GUEST_CLUSTER="$cluster"
export KUBECONFIG="$work/config" ZENITH_DATA="$work/data"

finish() {
  local original=$? cleanup=1 summary=1 remaining
  trap - EXIT INT TERM
  set +e
  if [[ $owned == 1 ]]; then
    timeout --signal=TERM --kill-after=10s 120s "$work/bin/kind" delete cluster --name "$cluster"
    [[ $? == 0 ]] || cleanup=0
    remaining=$(docker ps -aq --filter "label=io.x-k8s.kind.cluster=$cluster")
    [[ $? == 0 && -z $remaining ]] || cleanup=0
  fi
  rm -f -- "$KUBECONFIG"
  [[ ! -e $KUBECONFIG ]] || cleanup=0
  export ZENITH_KIND_CLEANUP="$cleanup" ZENITH_KIND_COMMAND_EXIT="$original"
  node --input-type=module - "$work" "$output" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { reportFailures } from './tests/ci/assert-lane-report.mjs';
const [work, output] = process.argv.slice(2);
const files = [
  'tests/providers/kubernetes/kind.test.ts',
  'tests/providers/kubernetes/release-kind.test.ts',
  'tests/machines/kubernetes-kind.test.ts',
  'tests/machines/kubernetes-guest-scoped-kind.test.ts',
];
let report = null, raw = '', verified = false, sourceUnchanged = false;
try {
  raw = fs.readFileSync(path.join(work, 'report.json'), 'utf8');
  report = JSON.parse(raw);
  verified = reportFailures(files.map(file => ({ file })), report, process.cwd()).length === 0 && report.testResults.length === files.length;
} catch { /* Missing/setup-failed/malformed evidence cannot pass. Never export raw diagnostics. */ }
try {
  sourceUnchanged = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === process.env.ZENITH_KIND_TESTED_SOURCE;
  execFileSync('git', ['diff', '--quiet']); execFileSync('git', ['diff', '--cached', '--quiet']);
} catch { sourceUnchanged = false; }
const counts = { passed: 0, failed: 0, skipped: 0 };
if (verified) for (const entry of report.testResults) for (const result of entry.assertionResults) {
  if (result.status === 'passed') counts.passed++;
  else if (result.status === 'failed') counts.failed++;
  else counts.skipped++;
}
const passed = verified && counts.passed > 0 && counts.failed === 0 && counts.skipped === 0 && sourceUnchanged &&
  process.env.ZENITH_KIND_TEST_EXIT === '0' && process.env.ZENITH_KIND_COMMAND_EXIT === '0' &&
  process.env.ZENITH_KIND_CLEANUP === '1' && process.env.ZENITH_KIND_VERSION_MATCHED === '1';
const evidence = {
  schemaVersion: 1, scope: 'github-hosted-linux-disposable-kind',
  source: process.env.ZENITH_KIND_TESTED_SOURCE, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  verdict: passed ? 'passed' : 'failed', sourceUnchanged, reportVerified: verified,
  counts: verified ? counts : null, testExitCode: Number(process.env.ZENITH_KIND_TEST_EXIT), commandExitCode: Number(process.env.ZENITH_KIND_COMMAND_EXIT),
  cleanupConfirmed: process.env.ZENITH_KIND_CLEANUP === '1', compatibleClientServer: process.env.ZENITH_KIND_VERSION_MATCHED === '1',
  node: process.version, platform: process.platform, arch: process.arch,
  kindVersion: '0.33.0', nodeImage: process.env.ZENITH_KIND_NODE_IMAGE,
  guestImage: process.env.ZENITH_TEST_KIND_RELEASE_IMAGE ?? null,
  reportSha256: raw ? createHash('sha256').update(raw).digest('hex') : null, files,
  limits: ['No live cloud or product release approval', 'Default kind CNI does not establish NetworkPolicy enforcement',
    'Existing provider suite uses nginx fixture tags resolved for this run; no source-pinned nginx claim',
    'Guest store/claims are local fixtures, not production database/operator authority'],
};
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = passed ? 0 : 1;
NODE
  summary=$?
  rm -rf -- "$work"
  [[ $original == 0 && $cleanup == 1 && $summary == 0 ]] && exit 0
  exit 1
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/bin"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 -o "$work/bin/kind"
printf '%s  %s\n' aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d "$work/bin/kind" | sha256sum --check --strict
chmod 700 "$work/bin/kind"
export PATH="$work/bin:$PATH"
kind version
existing=$(kind get clusters)
if grep -Fxq -- "$cluster" <<< "$existing"; then echo 'Cluster name already exists; refusing ownership.' >&2; exit 2; fi
owned=1
timeout --signal=TERM --kill-after=30s 300s kind create cluster --name "$cluster" --image "$ZENITH_KIND_NODE_IMAGE" --kubeconfig "$KUBECONFIG" --wait 180s
chmod 600 "$KUBECONFIG"
# Extract the client from the verified node image, avoiding unsupported client/server skew.
docker cp "$cluster-control-plane:/usr/bin/kubectl" "$work/bin/kubectl"
chmod 700 "$work/bin/kubectl"
kubectl version --output=json > "$work/version.json"
node --input-type=module - "$work/version.json" <<'NODE'
import fs from 'node:fs';
const version = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (version.clientVersion?.gitVersion !== 'v1.37.0' || version.serverVersion?.gitVersion !== 'v1.37.0') throw new Error('Client/server version mismatch.');
console.log('kubectl/server v1.37.0 matched');
NODE
export ZENITH_KIND_VERSION_MATCHED=1
# Resolve the public BusyBox tag once to its native manifest, then load/use that exact digest.
docker buildx imagetools inspect docker.io/library/busybox:1.37.0 --raw > "$work/busybox-index.json"
image_digest=$(node --input-type=module - "$work/busybox-index.json" <<'NODE'
import fs from 'node:fs';
const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const matches = index.manifests?.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
if (matches?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest)) throw new Error('No unique native BusyBox manifest.');
console.log(matches[0].digest);
NODE
)
export ZENITH_TEST_KIND_RELEASE_IMAGE="docker.io/library/busybox@$image_digest"
docker pull --platform linux/amd64 "$ZENITH_TEST_KIND_RELEASE_IMAGE"
kind load docker-image --name "$cluster" "$ZENITH_TEST_KIND_RELEASE_IMAGE"
for tag in stable-alpine stable; do
  docker pull --platform linux/amd64 "nginxinc/nginx-unprivileged:$tag"
  kind load docker-image --name "$cluster" "nginxinc/nginx-unprivileged:$tag"
done
set +e
timeout --signal=TERM --kill-after=60s 22m node node_modules/vitest/vitest.mjs run --project=node --maxWorkers=1 \
  tests/providers/kubernetes/kind.test.ts tests/providers/kubernetes/release-kind.test.ts \
  tests/machines/kubernetes-kind.test.ts tests/machines/kubernetes-guest-scoped-kind.test.ts \
  --reporter=default --reporter=json --outputFile.json="$work/report.json"
export ZENITH_KIND_TEST_EXIT=$?
set -e
exit "$ZENITH_KIND_TEST_EXIT"
