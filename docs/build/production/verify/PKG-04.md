# PKG-04 default installation topology

Implementation status: `implementation_complete_verification_pending`. This is a J1 implementation handoff, not verified installation or release evidence. Revision base: committed J1 `08d7d4b5`. No commit, package installation, migration rewrite, Docker operation or cloud call was performed on the builder.

## Acceptance mapping

Contract: “Reproducible API, durable product/platform stores, Temporal, workers and customer agents deploy from a clean host without hidden injected ports.”

| Clause | Implementation and proof |
| --- | --- |
| Isolated genuine local Supabase project | `scripts/acceptance/default-stack/config.mjs` creates a unique CLI project, pins CLI 2.75.0, enables real Auth/PostgREST and a transaction-mode Supavisor pooler. Every started CLI service is reopened at its actual native image ID and recorded in `supabase.images.json`. Pass `--supabase-image-lock <private snapshot>` to refuse a different image set on a subsequent clean host. The first vendor version resolution is recorded, not described as a previously reviewed digest lock. |
| Private-CA HTTPS and pooler TLS | Runtime OpenSSL CA/certificates; HTTPS edge in `deploy/self-hosted/supabase-gateway.mjs`; actual Supavisor `GLOBAL_DOWNSTREAM_CERT_PATH`/`GLOBAL_DOWNSTREAM_KEY_PATH`. Product URL is `supabase-pooler:6543/postgres?sslmode=verify-full`. API/worker mount only the public CA and use Node's verified TLS. `pooler-probe.mjs` requires successful native queries plus wrong-CA and wrong-hostname refusals. No certificate bypass or OS trust change. |
| Immutable local builds, native architecture | `up.mjs` builds the existing API, worker and migrator Dockerfiles serially, pushes to an owned registry on `localhost:5000`, obtains actual repository digests and refuses host/daemon/image architecture mismatch. Source binding is compared before/after builds and prepare, and again at readiness. No emulation evidence. |
| Disposable preparation and durable engines | Invokes the actual `installation.mjs prepare`; uses one CLI Supabase database for public/hosted/agent/platform and the pinned Temporal dev server. Prepared schemaVersion 2 derives the exact same runtime URLs; different platform URLs, wrong-project migrators and v1 dirs refuse. The migrator connects directly to the same Supabase project, verifies the checksummed ledger and must report a no-op. TLS, private-permission, symlink and shell-override guards remain. |
| Two APIs and two independent workers | Default profile renders two API processes with independent data volumes. `prepare --join` supplies identical custody/signing keys and authority configuration through a private keyring; peer worker has a distinct scratch volume. Lean renders one API and one worker without silently satisfying the two-worker clause. Pure contracts: `tests/deploy/default-stack.test.ts`; POSIX preparation/drift/Compose contracts: `tests/deploy/installation.native.test.ts` (explicit private-installation gate); pure URL contracts: `tests/deploy/installation.test.ts`. |
| Ownership, readiness and zero-resource cleanup | All new resources carry the installation label, or the exact unique CLI project label. Cleanup inspects labels before each mutation, drains workers, removes only owned containers/volumes/networks/local build images, then independently inventories absence. No global prune. Public base images and unlabelled BuildKit caches are retained. Successful cleanup also removes private credentials/certificates/backup files; sanitized receipts remain. Engine tests: `tests/deploy/default-stack.engine.test.ts` (three explicit gated cases). |
| MCP admission | `mcp-product-endpoint.ts` retains exact 20-character hosted project admission and matching pooler realm, and admits only the exact local HTTPS origin and verified-TLS pooler binding. Tests cover hosted 19/20/21 character cases, foreign realms, weaker TLS and unrelated database authorities. The native handle, REST-client ownership, same-database and locked-row checks remain mandatory. |
| Customer agents and actual cross-worker execution | Owned by J2/J4/J9 and DUR campaign joins. This harness provides the reachable installation/keyring seam; it does not manufacture registration, browser approval, execution or recovery receipts. |

## Exact Mac verification commands

Run serially on the frozen worktree. Required: native ARM64 Node 22, Docker Desktop/Compose 2.30+, Supabase CLI **2.75.0**, OpenSSL supporting `-addext`, and enough disk for image builds. Check `node --version`, `supabase --version`, `docker compose version`, `docker info`. No host `npm install` or `npm ci` is required. Existing Dockerfile recipes install their own locked image dependencies.

The lean running-service memory ceilings total **2912 MiB**, excluding temporary migration/probe containers, Docker overhead and build/bootstrap peaks. It is a plan, not a measured fit. Lean stops only its owned Supabase containers during image compilation and restarts them afterward. Use Docker 4 GiB RAM / 4 GiB swap on the 8 GB Mac, one workload at a time. The harness checks the host home filesystem's free space before each child command and every five seconds during it, enforcing the verifier's **22 GiB free disk floor**. It records the minimum observed value. If Docker's disk is on another filesystem, monitor that filesystem too. Cleanup remains available below the floor. The default two-API/two-worker plan exceeds 4 GiB; run it only with sufficient measured capacity. Do not report a lean run as default multiworker acceptance.

The OCI registry prerequisite must be a real digest, not a guessed pin. Resolve and inspect it before the run; preserve its actual digest and native architecture with the receipt:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --version
supabase --version
docker compose version
docker info --format '{{.Architecture}}'
docker pull registry:2.8.3
export ZENITH_DEFAULT_STACK_REGISTRY_IMAGE="$(docker image inspect registry:2.8.3 --format '{{index .RepoDigests 0}}')"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
export ZENITH_DEFAULT_STACK_PROFILE=lean
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$(python3 -c 'import os,tempfile; print(os.path.join(os.path.realpath(tempfile.gettempdir()), "zenith-j1-lean"))')"
# The chosen directory must not exist. Do not reuse or delete somebody else's directory.
npx vitest run tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/deploy/installation.test.ts --no-file-parallelism --maxWorkers=2
ZENITH_ACCEPTANCE_INSTALLATION_PRIVATE=1 npx vitest run tests/deploy/installation.native.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/deploy/default-stack.engine.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: pure tests green; POSIX installer contracts green including real Compose `config --quiet`; engine suite **3 passed / 0 failed / 0 skipped**, followed by `cleanup.receipt.json` showing zero owned Docker resources. A startup/migration/TLS/build failure is a failure; missing engine prerequisites are “not run (needs Docker/Supabase/POSIX)”. Absent opt-in gate produces three skipped engine cases, not three passes.

For a persistent stack used by J2/J4/J9/J10, use the same prerequisites and a fresh private directory:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/readiness.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/verify-database.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/cleanup.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
```

`up.mjs` without arguments chooses a fresh resolved system-temp directory and the default 2+2 profile, and prints its directory in the sanitized receipt. `--profile lean` is explicit. For default proof, use a new directory and `ZENITH_DEFAULT_STACK_PROFILE=default` with the engine suite; expect `apis=2`, `workers=2`, and independent scratch. The default pooler DB_POOL_SIZE is 15 (lean 5). Startup, readiness and database commands require `ZENITH_ACCEPTANCE_DEFAULT_STACK=1`; without it they exit **77** with “not-run”. Failure cleanup is attempted automatically; if it reports pending, retry `cleanup.mjs` using the private `state.json`. Cleanup never depends on successful preparation or an unmodified composition file.

Published host ports: API 36400 (peer 36401 only in default); Supabase HTTPS 54321; internal CLI gateway loopback 54326; Supabase database loopback 54322; TLS pooler 6543; Mailpit-compatible CLI mail UI 54324; registry 5000. Shadow database port 54320 and initial CLI pooler port 54329 are declared in config. There is no platform-db service or volume. Temporal has no host publication. Port collisions refuse startup; no automatic reassignment. `supabase.localhost` resolves to loopback in the browser and to the private HTTPS edge in the application network.

## Joins and first likely failures

- **One database is the only supported authority.** The installer and native MCP predicate now agree. Opened handles, actual postgres role, private default REST-client provenance and the final SQL predicate remain required; no fallback or alternate role exists. Version 1 private directories must be re-prepared with no data copy. Native admission and authenticated journeys still require Mac evidence.
- `prepare --join <parent/keyring.json> <new-private-directory>` is supported. The keyring must remain beside its canonical `installation.json` and effective env files; altered/detached keyrings refuse. Start the standalone join with its generated `worker.compose.json` on the parent network. For this local private-CA installation, also mount the parent's `tls/ca.crt` read-only and set `NODE_EXTRA_CA_CERTS=/run/zenith-ca.crt` in an explicit Compose override. The default peer worker already includes that mount automatically. Do not share any worker scratch mount.
- Full browser trust is J2's isolated browser-profile CA join. This harness changes no personal browser profile or global trust store. OAuth client interoperability/issuer is J10's join; no local authorization server was introduced.
- Fresh immutable SQL may expose upstream migration/compatibility failures. Preserve the actual refusal and coordinate with the migration owner; never edit published snapshots or weaken contract admission.
- CLI image names, mounts, TLS certificate readability, status JSON fields, and real ARM64 image pins need the actual Mac successor. Unsupported/mismatched resources refuse; no dummy service substitutes.
- Wave-5 maintenance, rotation, archive, clean-host recovery and release harnesses remain owned there. No new tables, migrations, dependencies or gate-manifest entries. The orchestrator may register the gated engine suite after its real successor is reviewed.

Primary configuration references: [Supabase CLI 2.75.0 start code](https://github.com/supabase/cli/blob/v2.75.0/internal/start/start.go), [Supavisor downstream TLS configuration](https://github.com/supabase/supavisor/blob/v2.7.4/config/runtime.exs), [CLI project configuration](https://supabase.com/docs/guides/local-development/cli/config). Actual resolved pooler image identity is recorded and any TLS incompatibility must fail the real probe.

## Single database, PostgREST isolation and native CAS successor

Run the persistent `up` command above first; leave it running until these checks
finish. `readiness.mjs` fails unless both native handles return the same
`current_database()` and `pg_control_system().system_identifier`, every platform
table has RLS, anon/authenticated lack USAGE on platform/agent, and real PostgREST
refuses both Accept-Profile requests with HTTP 406 / PGRST106. The maximum migration
version must equal `Math.max(...PLATFORM_MIGRATIONS.map(m => m.version))` imported
from this image's `src/lib/controlplane/db/migrations/index.ts`. There is no fixed
version bound. `verify-database.mjs` records these identities/versions and a single
backup/restore covering all four schemas. Expected: failed=0, skipped=0,
sameDatabase=true, sameSystemIdentifier=true, both versions equal, all native
privilege/RLS checks true. The `platform-migrate --status` check precedes its no-op
run; a missing or changed migration refuses rather than silently repairing startup.

Run the existing 18 native admission cases **through the stack's TLS pooler**, not
the direct migration endpoint. On the host, localhost replaces only the container
DNS name; the certificate includes localhost. Do not print the private URL:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/tls/ca.crt"
export ZENITH_TEST_PLATFORM_PG_URL="$(node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR+"/installation/installation.json","utf8")); const u=new URL(c.environment.SUPABASE_DB_URL); u.hostname="localhost"; process.stdout.write(u.href);')"
export ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED=1
npx vitest run tests/controlplane/mcp-deploy-admission.test.ts --no-file-parallelism --maxWorkers=2
export ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED=1
npx vitest run tests/controlplane/mcp-start-source-authority.test.ts --no-file-parallelism --maxWorkers=2
unset ZENITH_TEST_PLATFORM_PG_URL ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED
```

Expected: first command **18 passed / 0 failed / 0 skipped**; second command all
native cases green with zero skips. The unchanged second suite deliberately holds
capture/role barriers, changes native full manifest JSON or native membership
(demotion/removal) from an independent pool, then releases claim. It asserts
phase=prepared, attempt_id=null and zero dispatch; unchanged controls permit one
permanent attempt. These are actual PostgreSQL CAS contracts with explicit modeled
external protocols, distinct from the live two-API check below.

## MCP proposal, human browser approval and two API claims

Use an actual J2-owned local target/customer agent and saved revision, a browser-created
linked MCP credential, and a policy requiring a human approval. No cloud credentials,
cloud endpoints or manufactured grants. J2 supplies private `mcp.prepare.args.json`
(the strict PrepareDeployInput: target, revisionId, unique idempotencyKey) and
`mcp.bearer` (only the scoped local linked bearer) in this installation directory.
Authenticate normally in the browser; this procedure never approves via SQL or an
MCP approval field. A non-production transport stub is not live acceptance.

Two actual API processes are needed. The default 2+2 profile already provides them.
On the 4 GiB Docker lean run, start one temporary real peer API with a 512 MiB cap
and independent tmpfs scratch. This raises the running ceiling to 3424 MiB; run
native test suites first and one acceptance workload at a time. It does not turn a
lean run into default 2-worker evidence. The temporary API has the same ownership
label and image digest and is selected by ordinary cleanup.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { readState, docker, requireEngineGate } from './scripts/acceptance/default-stack/runtime.mjs';
import { readPrepared } from './scripts/deploy/installation.mjs';
requireEngineGate();
const dir=process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, state=readState(dir), c=readPrepared(path.join(dir,'installation'));
if (state.profile === 'lean') {
  await docker(['run','-d','--name','zenith-mcp-peer-'+state.installationId,
    '--label','io.zenith.installation='+state.installationId,'--network',c.projectName+'_installation',
    '--user','1001:1001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--memory','512m','--cpus','1','--pids-limit','256','--env-file',path.join(dir,'installation/api.env'),
    '-e','NODE_EXTRA_CA_CERTS=/run/zenith-ca.crt','--mount','type=bind,source='+path.join(dir,'tls/ca.crt')+',target=/run/zenith-ca.crt,readonly',
    '--tmpfs','/data:rw,nosuid,size=64m,uid=1001,gid=1001,mode=1770',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=64m,uid=1001,gid=1001,mode=1770',
    '--tmpfs','/app/.next/cache:rw,noexec,nosuid,size=64m,uid=1001,gid=1001,mode=1770',
    '-p','127.0.0.1:36401:3400',c.images.api]);
}
NODE
# Wait for the genuine peer to be healthy; no synthetic readiness server.
curl --fail --silent http://127.0.0.1:36401/api/me
node --input-type=module <<'NODE'
import fs from 'node:fs';
const dir=process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR;
const args=JSON.parse(fs.readFileSync(dir+'/mcp.prepare.args.json','utf8'));
const token=fs.readFileSync(dir+'/mcp.bearer','utf8').trim();
if (!token || /[\r\n\0]/.test(token)) throw new Error('Invalid private local bearer');
fs.writeFileSync(dir+'/mcp.headers','Authorization: Bearer '+token+'\nContent-Type: application/json\nAccept: application/json, text/event-stream\nMCP-Protocol-Version: 2025-11-25\nx-zenith-workspace: '+args.target.workspaceId+'\n',{mode:0o600,flag:'wx'});
fs.writeFileSync(dir+'/mcp.prepare.rpc.json',JSON.stringify({jsonrpc:'2.0',id:'j1-propose',method:'tools/call',params:{name:'zenith_prepare_deploy',arguments:args}}),{mode:0o600,flag:'wx'});
NODE
curl --fail --silent --show-error --header @"$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/mcp.headers" --data-binary @"$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/mcp.prepare.rpc.json" http://127.0.0.1:36400/api/agent/v3/mcp > "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/mcp.proposal.json"
node --input-type=module <<'NODE'
import fs from 'node:fs';
const dir=process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR;
const rpc=JSON.parse(fs.readFileSync(dir+'/mcp.proposal.json','utf8')), envelope=rpc.result?.structuredContent;
if (!envelope?.ok || envelope.simulated || envelope.data.status !== 'awaiting_approval' || envelope.data.executed !== false) throw new Error('A real human approval proposal is required');
console.log(envelope.data.approval.url);
NODE
```

Open the printed URL as the authorized human, inspect the exact proposal and approve
in the browser. Keep the approved operation's id/digest. Then run the simultaneous
claims; all response files are private and no bearer is printed:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readState, docker, requireEngineGate } from './scripts/acceptance/default-stack/runtime.mjs';
import { readPrepared } from './scripts/deploy/installation.mjs';
requireEngineGate();
const dir=process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, state=readState(dir), config=readPrepared(dir+'/installation');
const args=JSON.parse(fs.readFileSync(dir+'/mcp.prepare.args.json','utf8'));
const proposal=JSON.parse(fs.readFileSync(dir+'/mcp.proposal.json','utf8')).result.structuredContent.data;
const ws=args.target.workspaceId, op=proposal.operationId;
if (!/^[A-Za-z0-9_-]{1,100}$/.test(ws) || !/^[A-Za-z0-9_-]{1,100}$/.test(op) || !/^[a-f0-9]{64}$/.test(proposal.proposalDigest)) throw new Error('Invalid owned identity');
const sql = text => docker(['exec','-i','supabase_db_'+state.projectId,'psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],{input:text});
const approved=await sql("select count(*) from platform.approvals where workspace_id='"+ws+"' and operation_id='"+op+"' and proposal_digest='"+proposal.proposalDigest+"' and decision='approve' and consumed_at is null and expires_at>clock_timestamp() and approver->>'kind'='user';");
if (Number(approved)<1) throw new Error('Real unconsumed browser approval is required');
const headers=Object.fromEntries(fs.readFileSync(dir+'/mcp.headers','utf8').trim().split('\n').map(line=>{const i=line.indexOf(':');return [line.slice(0,i),line.slice(i+1).trim()];}));
headers.Host='127.0.0.1:36400'; // same configured origin, both declared API transports
const call = async port => {
  const response=await fetch('http://127.0.0.1:'+port+'/api/agent/v3/mcp',{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'zenith_execute_approved_operation',arguments:{workspaceId:ws,operationId:op,expectedDigest:proposal.proposalDigest}}}),signal:AbortSignal.timeout(60000)});
  const body=await response.json(); fs.writeFileSync(dir+'/mcp.claim-'+port+'.json',JSON.stringify(body),{mode:0o600,flag:'wx'}); return body;
};
const replies=await Promise.all([call(36400),call(36401)]);
const successes=replies.map(r=>r.result?.structuredContent).filter(e=>e?.ok && !e.simulated && e.data.workflow?.id);
if (!successes.length || new Set(successes.map(e=>e.data.workflow.id)).size!==1) throw new Error('No single confirmed workflow');
const evidence=await sql("select json_build_object('rows',count(*),'attempts',count(attempt_id),'acknowledged',count(*) filter(where phase='acknowledged'),'runId',min(run_id),'workflowId',min(binding->>'workflowId')) from platform.workflow_start_intents where workspace_id='"+ws+"' and operation_id='"+op+"';");
const observed=JSON.parse(evidence);
if (Number(observed.rows)!==1 || Number(observed.attempts)!==1 || Number(observed.acknowledged)!==1 || !observed.runId || observed.workflowId!==successes[0].data.workflow.id) throw new Error('Exactly one permanent acknowledged attempt required');
const history = JSON.parse(await docker(['run','--rm','--network',config.projectName+'_installation',
  '--label','io.zenith.installation='+state.installationId,'--user','1001:1001','--read-only','--cap-drop','ALL',
  '--security-opt','no-new-privileges:true','--memory','192m','--env-file',dir+'/installation/worker.env',
  '-e','J1_WORKFLOW_ID='+observed.workflowId,'-e','J1_RUN_ID='+observed.runId,'--entrypoint','node',config.images.migration,
  '--input-type=module','-'],{input:`import { Client, Connection } from '@temporalio/client';
    const connection=await Connection.connect({address:process.env.ZENITH_TEMPORAL_ADDRESS});
    try { const client=new Client({connection,namespace:process.env.ZENITH_TEMPORAL_NAMESPACE});
      const history=await client.workflow.getHandle(process.env.J1_WORKFLOW_ID,process.env.J1_RUN_ID).fetchHistory();
      const started=history.events?.filter(event=>event.workflowExecutionStartedEventAttributes).length;
      if (started!==1) throw new Error('One real Temporal start is required');
      process.stdout.write(JSON.stringify({started,eventCount:history.events.length}));
    } finally { await connection.close(); }`}));
if (history.started!==1) throw new Error('One native transport start required');
fs.writeFileSync(dir+'/mcp.temporal.receipt.json',JSON.stringify(history),{mode:0o600,flag:'wx'});
fs.writeFileSync(dir+'/mcp.claim.receipt.json',JSON.stringify({kind:'local_engine',passed:1,failed:0,skipped:0,...observed,productionReady:false}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({passed:1,failed:0,skipped:0,permanentAttempts:observed.attempts}));
NODE
node scripts/acceptance/default-stack/readiness.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/verify-database.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/cleanup.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
```

Expected: propose executes nothing, a genuine human approval is recorded, concurrent
calls reach both APIs, and exactly one immutable attempted/acknowledged intent names
the confirmed workflow/run. A losing caller may refuse while the winner settles;
no second dispatch is allowed. Retain private claim replies and the Temporal server's
matching workflow/run history as independent transport evidence. A failure or
unconfirmed dispatch remains failed, never a pass. This procedure uses only the
existing prepared-to-attempted CAS; it never writes an attempt or approval itself.
Both claims send the actual canonical Host, never a forwarded-host override.
Run readiness and database isolation afterward, then expect cleanup's
ownedResourcesRemaining=0, including the temporary peer. Keep sanitized receipts,
remove private MCP headers/bearers/replies after review. J2 owns the real browser,
local target and linked-credential fixture; J10 owns OAuth interoperability. No
hosted production or cloud acceptance follows from this local successor.
