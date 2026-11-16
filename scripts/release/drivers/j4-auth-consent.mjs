/**
 * J4 A1 candidate. Source-only adapter for real local Auth, MFA and machine
 * consent. The module is not wired into the repository and was not executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { browserRequest, operator, localUrl } from '../../../tests/e2e/default/support.mjs';
import { enrollOperator } from '../../../tests/e2e/default/mfa.mjs';
import { readState } from '../../acceptance/default-stack/runtime.mjs';

const ADDRESS = 'service/witness';
const TOKEN_HANDLES = new WeakMap();
const AUTH_OWNERS = new WeakMap();
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{3,19}$/;
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const fail = id => { throw new Error(`j4-a1:${id}`); };
const need = (value, id) => { if (!value) fail(id); return value; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('json-object');
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail('json-number');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail('json-value');
  return value;
}
const canonicalSha256 = value => hash(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));

function assertOwnedDirectory(directory, expected) {
  need(path.isAbsolute(directory) && path.resolve(directory) === directory, 'private-dir-path');
  const real = fs.realpathSync(directory), stat = fs.lstatSync(directory);
  need(real === directory && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && (stat.mode & 0o777) === 0o700, 'private-dir-owner-mode');
  need(directory === expected, 'private-dir-r9-binding');
  for (let current = directory; current !== path.dirname(current); current = path.dirname(current))
    need(!fs.lstatSync(current).isSymbolicLink(), 'private-dir-ancestor');
  return real;
}

function assertPrivateFile(file, expectedHash, directory) {
  const maxBytes = 1024 * 1024;
  need(path.isAbsolute(file) && path.dirname(file) === directory && SHA256.test(expectedHash ?? ''), 'private-file-ref');
  need(typeof process.getuid === 'function', 'private-file-uid-unavailable');
  const before = fs.lstatSync(file);
  const noFollow = fs.constants.O_NOFOLLOW, nonBlock = fs.constants.O_NONBLOCK;
  need(Number.isInteger(noFollow) && Number.isInteger(nonBlock), 'private-file-open-flags-unavailable');
  const validStat = stat => stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
    && stat.nlink === 1 && stat.size <= maxBytes;
  const sameSnapshot = (left, right) => left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && (left.mode & 0o777) === (right.mode & 0o777) && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  need(validStat(before), 'private-file-owner-mode');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = fs.fstatSync(fd);
    need(validStat(opened) && sameSnapshot(opened, before), 'private-file-open-identity');
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) need(false, 'private-file-size-bound');
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      need(total <= maxBytes, 'private-file-size-bound');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd), pathAfter = fs.lstatSync(file);
    need(validStat(after) && validStat(pathAfter) && sameSnapshot(after, opened)
      && sameSnapshot(pathAfter, opened) && bytes.length === opened.size
      && hash(bytes) === expectedHash, 'private-file-read-identity-or-hash');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function verifyBinding(r9Binding, coordinatorPin) {
  need(r9Binding && r9Binding.schemaVersion === 1 && r9Binding.kind === 'j4_fixture_binding', 'binding-kind');
  need(Object.keys(r9Binding).sort().join(',') === ['apiOrigin','bindingSha256','cleanupEpoch','evidence','kind','privateDir','r16SourceFreezeSha256','r9','runId','runtime','schemaVersion','source','supabaseOrigin'].sort().join(','), 'binding-closed-root');
  need(RUN_ID.test(r9Binding.runId ?? '') && r9Binding.source?.dirty === false
    && /^[a-f0-9]{40}$/.test(r9Binding.source?.head ?? '') && SHA256.test(r9Binding.source?.contentSha256 ?? '')
    && SHA256.test(r9Binding.r16SourceFreezeSha256 ?? '') && typeof r9Binding.cleanupEpoch === 'string'
    && Number.isFinite(Date.parse(r9Binding.cleanupEpoch)), 'binding-source-types');
  const { bindingSha256, ...withoutDigest } = r9Binding;
  need(SHA256.test(bindingSha256 ?? '') && canonicalSha256(withoutDigest) === bindingSha256, 'binding-digest');
  need(r9Binding.privateDir === path.join(r9Binding.r9?.privateRuntime ?? '', 'signed-delivery'), 'binding-private-dir');
  need(new URL(r9Binding.apiOrigin).origin === r9Binding.apiOrigin && localUrl(r9Binding.apiOrigin) === r9Binding.apiOrigin,
    'binding-api-origin');
  need(new URL(r9Binding.supabaseOrigin).origin === r9Binding.supabaseOrigin
    && localUrl(r9Binding.supabaseOrigin, true) === r9Binding.supabaseOrigin, 'binding-supabase-origin');
  const expected = {
    source: r9Binding.source, r16SourceFreezeSha256: r9Binding.r16SourceFreezeSha256,
    bindingSha256: r9Binding.bindingSha256, cleanupEpoch: r9Binding.cleanupEpoch,
    r9FileSha256: Object.fromEntries(['joined','state','ownership','preapi','prestart','completion','readiness'].map(key => [key, r9Binding.r9[key].sha256])),
    evidenceSha256: Object.fromEntries(['r16Summary','r16Execution','witnessR10'].map(key => [key, r9Binding.evidence[key].sha256])),
    runtimeIds: Object.fromEntries(['installationId','applicationInstallationId','supabaseProjectId','apiContainerId','databaseContainerId','workerContainerId','databaseIdentitySha256'].map(key => [key, r9Binding.runtime[key]])),
  };
  const requiredCoordinatorKeys = ['schemaVersion','kind','source','r16SourceFreezeSha256','bindingSha256','cleanupEpoch','r9FileSha256','evidenceSha256','runtimeIds'];
  need(coordinatorPin && Object.keys(coordinatorPin).sort().join(',') === requiredCoordinatorKeys.sort().join(',')
    && coordinatorPin.kind === 'j4_verified_coordinator_pin' && coordinatorPin.schemaVersion === 1
    && canonicalSha256(Object.fromEntries(Object.keys(expected).map(key => [key, coordinatorPin[key]]))) === canonicalSha256(expected),
  'coordinator-source-r9-r16-join');
  return r9Binding;
}

function parsePrivateEnvironment(bytes) {
  const env = Object.create(null);
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const at = line.indexOf('=');
    need(at > 0, 'host-env-format');
    const key = line.slice(0, at), value = line.slice(at + 1);
    need(/^[A-Z][A-Z0-9_]*$/.test(key) && !/[\r\n\0]/.test(value) && !(key in env), 'host-env-entry');
    env[key] = value;
  }
  return env;
}

function writePrivate(directory, name, bytes) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const sha256 = hash(bytes);
  assertPrivateFile(file, sha256, directory);
  return { path: file, sha256 };
}

async function authenticate(page, apiOrigin, supabaseOrigin, user) {
  await page.goto(`${apiOrigin}/login?next=/overview`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  const signedIn = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === supabaseOrigin && url.pathname === '/auth/v1/token'
      && url.searchParams.get('grant_type') === 'password';
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await signedIn;
  const body = await response.json();
  need(response.ok() && body.user?.id === user.id, 'auth-session-identity');
  await page.waitForURL(url => url.origin === apiOrigin && url.pathname !== '/login');
}

/** Create the two fresh actual local operators and own their live browser pages. */
export async function prepareAuthContext({ r9Binding, coordinatorPin, privateDir = r9Binding?.privateDir }) {
  const binding = verifyBinding(r9Binding, coordinatorPin);
  const privateRoot = assertOwnedDirectory(privateDir, binding.privateDir);
  const stackDirectory = binding.r9.stackDirectory;
  need(path.isAbsolute(stackDirectory) && fs.realpathSync(stackDirectory) === stackDirectory, 'stack-directory');
  const state = readState(stackDirectory);
  need(state.directory === stackDirectory, 'stack-state-owner');
  const stateBytes = assertPrivateFile(binding.r9.state.path, binding.r9.state.sha256, stackDirectory);
  need(hash(stateBytes) === binding.r9.state.sha256, 'stack-state-hash');
  const hostRef = binding.runtime.hostEnvironment;
  need(path.dirname(hostRef.path) === privateRoot, 'host-env-binding');
  const hostEnv = parsePrivateEnvironment(assertPrivateFile(hostRef.path, hostRef.sha256, privateRoot));
  need(localUrl(hostEnv.ZENITH_J4_API_ORIGIN) === binding.apiOrigin
    && localUrl(hostEnv.SUPABASE_URL, true) === binding.supabaseOrigin
    && ID(hostEnv.SUPABASE_SERVICE_ROLE_KEY) && hostEnv.ZENITH_DEFAULT_MAILPIT_URL,
  'host-env-r9-join');
  need(localUrl(hostEnv.ZENITH_DEFAULT_MAILPIT_URL) === localUrl(state.mailpitUrl), 'mailpit-r9-join');

  const stack = { apiUrl: binding.apiOrigin, supabaseUrl: binding.supabaseOrigin,
    adminKey: hostEnv.SUPABASE_SERVICE_ROLE_KEY };
  const pins = JSON.parse(fs.readFileSync(path.resolve('node_modules/playwright-core/browsers.json'), 'utf8'));
  const testPackage = JSON.parse(fs.readFileSync(path.resolve('node_modules/@playwright/test/package.json'), 'utf8'));
  const chromiumPin = pins.browsers?.find(item => item.name === 'chromium');
  need(testPackage.version === '1.56.1' && chromiumPin?.revision === '1194'
    && chromiumPin.browserVersion === '141.0.7390.37', 'playwright-chromium-pin');
  const executablePath = chromium.executablePath();
  need(path.isAbsolute(executablePath) && executablePath.includes(`chromium-1194`), 'chromium-executable-pin');
  const users = [];
  let browser, requesterContext, approverContext;
  const custodyMarker = writePrivate(privateRoot, `j4-auth-${binding.runId}.custody`,
    Buffer.from('A1-owned-auth-and-browser-setup-in-progress; outer R17 owner must settle or retain\n', 'utf8'));
  try {
    browser = await chromium.launch({ headless: true });
    need(browser.version() === chromiumPin.browserVersion, 'chromium-runtime-version');
    requesterContext = await browser.newContext({ ignoreHTTPSErrors: false });
    approverContext = await browser.newContext({ ignoreHTTPSErrors: false });
    const requesterPage = await requesterContext.newPage();
    const approverPage = await approverContext.newPage();
    const requester = await operator(stack, hostEnv.ZENITH_DEFAULT_MAILPIT_URL, `j4-${binding.runId}-requester`, users);
    const approver = await operator(stack, hostEnv.ZENITH_DEFAULT_MAILPIT_URL, `j4-${binding.runId}-approver`, users);
    need(requester.id !== approver.id, 'distinct-auth-users');
    await authenticate(requesterPage, binding.apiOrigin, binding.supabaseOrigin, requester);
    await authenticate(approverPage, binding.apiOrigin, binding.supabaseOrigin, approver);
    await enrollOperator(requesterPage, stack);
    await enrollOperator(approverPage, stack);
    const facts = {
      schemaVersion: 1, kind: 'j4_auth_owner_facts', runId: binding.runId, bindingSha256: binding.bindingSha256,
      coordinatorPinSha256: canonicalSha256(coordinatorPin), source: binding.source, r16SourceFreezeSha256: binding.r16SourceFreezeSha256, cleanupEpoch: binding.cleanupEpoch,
      apiOrigin: binding.apiOrigin, supabaseOrigin: binding.supabaseOrigin,
      requesterUserId: requester.id, approverUserId: approver.id, approverEmail: approver.email,
      requesterPasswordSession: 'observed', approverPasswordSession: 'observed',
      requesterMfaServerProof: 'observed', approverMfaServerProof: 'observed',
      browser: { playwrightVersion: testPackage.version, chromiumRevision: chromiumPin.revision,
        chromiumVersion: browser.version(), executablePath },
      ownership: { userIds: [...users], browserContexts: 2, custodyMarker, cleanup: 'outer-r17-owner' },
    };
    const ownerReceipt = writePrivate(privateRoot, `j4-auth-${binding.runId}.private.json`,
      Buffer.from(`${JSON.stringify(facts, null, 2)}\n`, 'utf8'));
    const authOwnerFacts = Object.freeze({ ...facts, ownerReceipt });
    const actualBrowserContext = Object.freeze({ requesterPage, approverPage, requesterContext, approverContext, browser,
      requesterUserId: requester.id, approverUserId: approver.id, approverEmail: approver.email,
      ownedAuthUserIds: Object.freeze([...users]) });
    AUTH_OWNERS.set(authOwnerFacts, { bindingSha256: binding.bindingSha256,
      coordinatorPinSha256: canonicalSha256(coordinatorPin), privateRoot, actualBrowserContext, ownerReceipt });
    return { authOwnerFacts, actualBrowserContext };
  } catch {
    // The marker is monotonic: partial/unknown user creation or browser close
    // remains owned by the outer R17 process for exact readback and retention.
    const error = new Error('j4-a1:auth-context-incomplete-retain-owned-state');
    Object.defineProperty(error, 'a1Custody', { enumerable: false, value: Object.freeze({
      userIds: Object.freeze([...users]), browser, requesterContext, approverContext, custodyMarker,
      authCreationMayBeUncertain: true, cleanup: 'outer-r17-owner-retain-until-exact-settlement',
    }) });
    throw error;
  }
}

/** Consent only after the actual A2 target is persisted and positively read back. */
export async function prepareConsent({ r9Binding, coordinatorPin, page, authOwnerFacts, targetFacts }) {
  const binding = verifyBinding(r9Binding, coordinatorPin);
  const owner = AUTH_OWNERS.get(authOwnerFacts);
  need(owner && owner.bindingSha256 === binding.bindingSha256
    && owner.coordinatorPinSha256 === canonicalSha256(coordinatorPin)
    && owner.actualBrowserContext.requesterPage === page, 'same-invocation-auth-owner');
  const authReceiptBytes = assertPrivateFile(authOwnerFacts.ownerReceipt.path, authOwnerFacts.ownerReceipt.sha256, owner.privateRoot);
  const authReceipt = JSON.parse(authReceiptBytes.toString('utf8'));
  need(authReceipt.kind === 'j4_auth_owner_facts' && authReceipt.runId === binding.runId
    && authReceipt.bindingSha256 === binding.bindingSha256
    && authReceipt.coordinatorPinSha256 === canonicalSha256(coordinatorPin)
    && authReceipt.requesterUserId === authOwnerFacts.requesterUserId
    && authReceipt.approverUserId === authOwnerFacts.approverUserId
    && authReceipt.approverEmail === authOwnerFacts.approverEmail
    && authReceipt.requesterMfaServerProof === 'observed' && authReceipt.approverMfaServerProof === 'observed',
  'auth-owner-receipt-join');
  need(targetFacts && targetFacts.schemaVersion === 1 && targetFacts.kind === 'j4_target_facts'
    && targetFacts.runId === binding.runId && targetFacts.bindingSha256 === binding.bindingSha256
    && ID(targetFacts.workspaceId) && ID(targetFacts.projectId) && ID(targetFacts.environmentId)
    && ID(targetFacts.resourceId) && targetFacts.address === ADDRESS && targetFacts.createdAfterEpoch === true
    && typeof targetFacts.environmentCreatedAt === 'string' && typeof targetFacts.resourceCreatedAt === 'string'
    && ID(targetFacts.deploymentId) && ID(targetFacts.operationId) && SHA256.test(targetFacts.resourceReadbackSha256 ?? ''),
  'target-facts-join');
  const targetBytes = assertPrivateFile(targetFacts.ownerReceipt.path, targetFacts.ownerReceipt.sha256, owner.privateRoot);
  const targetReceipt = JSON.parse(targetBytes.toString('utf8'));
  const target = targetReceipt.target;
  const timestamps = targetReceipt.timestamps, readbacks = targetReceipt.readbacks, resource = targetReceipt.resource;
  need(targetReceipt.schemaVersion === 1 && targetReceipt.kind === 'j4_target_owner_receipt'
    && targetReceipt.runId === binding.runId && targetReceipt.bindingSha256 === binding.bindingSha256
    && canonicalSha256(targetReceipt.source) === canonicalSha256(binding.source)
    && targetReceipt.r16SourceFreezeSha256 === binding.r16SourceFreezeSha256
    && targetReceipt.cleanupEpoch === binding.cleanupEpoch
    && exactKeys(target, ['workspaceId','projectId','environmentId','resourceId','address','connectionId','deploymentId','operationId'])
    && target?.workspaceId === targetFacts.workspaceId && target?.projectId === targetFacts.projectId
    && target?.environmentId === targetFacts.environmentId && target?.resourceId === targetFacts.resourceId
    && target?.address === ADDRESS && ID(target?.connectionId) && target?.deploymentId === targetFacts.deploymentId
    && target?.operationId === targetFacts.operationId
    && exactKeys(resource, ['provider','kind','nativeType','ownership','status','revisionId'])
    && resource.provider === 'kubernetes' && resource.kind === 'container_service'
    && resource.nativeType === 'k8s:Deployment' && resource.ownership === 'managed'
    && resource.status === 'active' && ID(resource.revisionId)
    && exactKeys(timestamps, ['environmentCreatedAt','resourceCreatedAt','createdAfterEpoch'])
    && timestamps.environmentCreatedAt === targetFacts.environmentCreatedAt
    && timestamps.resourceCreatedAt === targetFacts.resourceCreatedAt && timestamps.createdAfterEpoch === true
    && exactKeys(readbacks, ['runtimeOwnershipSha256','kindBindingSha256','connectionSha256','deploymentSha256','resourceReadbackSha256'])
    && ['runtimeOwnershipSha256','kindBindingSha256','connectionSha256','deploymentSha256','resourceReadbackSha256']
      .every(key => SHA256.test(readbacks[key] ?? ''))
    && readbacks.resourceReadbackSha256 === targetFacts.resourceReadbackSha256,
  'target-owner-receipt-join');
  const epochMs = Date.parse(binding.cleanupEpoch), envCreatedMs = Date.parse(timestamps.environmentCreatedAt);
  const resourceCreatedMs = Date.parse(timestamps.resourceCreatedAt);
  need(Number.isFinite(epochMs) && Number.isFinite(envCreatedMs) && Number.isFinite(resourceCreatedMs)
    && envCreatedMs > epochMs && resourceCreatedMs > epochMs && targetFacts.createdAfterEpoch === true,
  'target-created-after-exact-epoch');

  const bootstrap = await browserRequest(page, '/api/bootstrap', undefined, 'GET', targetFacts.workspaceId);
  need(bootstrap.status === 200, 'bootstrap-readback');
  const shell = bootstrap.data, userId = shell?.user?.id;
  need(userId === authOwnerFacts.requesterUserId && shell?.auth?.configured === true
    && shell?.workspace?.id === targetFacts.workspaceId && shell?.role === 'admin'
    && shell.workspaces?.some(row => row.id === targetFacts.workspaceId && row.role === 'admin')
    && shell.members?.some(row => row.id === userId && row.workspaceId === targetFacts.workspaceId && row.role === 'admin'),
  'actual-requester-admin');
  const env = shell.environments?.find(row => row.id === targetFacts.environmentId);
  need(env && shell.projects?.some(row => row.id === targetFacts.projectId && row.workspaceId === targetFacts.workspaceId
    && row.id === env.projectId), 'actual-target-environment');
  const project = shell.projects.find(row => row.id === targetFacts.projectId);
  need(project.workspaceId === targetFacts.workspaceId && env.projectId === targetFacts.projectId, 'environment-project-join');

  const consentRequest = { kind: 'machine', ttlMinutes: 1,
    binding: { environmentId: targetFacts.environmentId, address: targetFacts.address } };
  const requestSha256 = canonicalSha256(consentRequest);
  const cookies = await page.context().cookies(binding.apiOrigin);
  need(cookies.length > 0 && cookies.every(cookie => !/[\r\n]/.test(cookie.name + cookie.value)), 'origin-cookie-readback');
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  need(cookieHeader.length > 0 && !/[\r\n]/.test(cookieHeader), 'cookie-header-safe');
  const cookieFile = writePrivate(owner.privateRoot, `j4-browser-cookie-${binding.runId}.private`, Buffer.from(cookieHeader, 'utf8'));
  const issuanceIntent = writePrivate(owner.privateRoot, `j4-consent-${binding.runId}.intent.private.json`,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'j4_consent_issuance_intent',
      runId: binding.runId, bindingSha256: binding.bindingSha256, coordinatorPinSha256: canonicalSha256(coordinatorPin),
      target: { workspaceId: targetFacts.workspaceId, projectId: targetFacts.projectId, environmentId: targetFacts.environmentId,
        resourceId: targetFacts.resourceId, address: targetFacts.address }, requestSha256, cookieFile,
      status: 'issuance_unconfirmed', disposition: 'outer-r17-retain-until-settled' }, null, 2)}\n`, 'utf8'));
  let issuanceStatus = 'issuance_unconfirmed', privateTokenHandle, tokenJoin;
  try {
    const issued = await browserRequest(page, '/api/platform/v1/runners/tokens', consentRequest, 'POST', targetFacts.workspaceId);
    issuanceStatus = issued.status === 201 ? 'response_observed_201' : 'response_observed_non201';
    if (issued.status === 201 && typeof issued.data?.token === 'string' && issued.data.token.length > 0) {
      // Capture the credential immediately; every later failure carries this opaque handle.
      privateTokenHandle = Object.freeze({ kind: 'j4_private_token_handle' });
      tokenJoin = { runId: binding.runId, bindingSha256: binding.bindingSha256, workspaceId: targetFacts.workspaceId,
        environmentId: targetFacts.environmentId, address: targetFacts.address, expiresAt: issued.data.expiresAt };
      TOKEN_HANDLES.set(privateTokenHandle, { token: issued.data.token, ...tokenJoin, consumed: false });
    }
    need(issued.status === 201 && issued.data?.kind === 'machine' && issued.data?.workspaceId === targetFacts.workspaceId
      && issued.data?.shownOnce === true && privateTokenHandle && /^zmt_[A-Za-z0-9_-]{32}$/.test(issued.data.token)
      && ID(issued.data.expiresAt), 'actual-machine-consent');
    const expiry = Date.parse(issued.data.expiresAt);
    need(Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 60_000 + 30_000, 'token-expiry');

    const consentFacts = {
      schemaVersion: 1, kind: 'j4_consent_facts', runId: binding.runId, bindingSha256: binding.bindingSha256,
      workspaceId: targetFacts.workspaceId, environmentId: targetFacts.environmentId, resourceId: targetFacts.resourceId,
      address: targetFacts.address, actorUserId: userId, actorRole: 'admin', requestSha256,
      responseStatus: issued.status, shownOnce: issued.data.shownOnce, expiresAt: issued.data.expiresAt,
      registration: 'not_created', cookieFile,
    };
    need(Object.keys(consentFacts).sort().join(',') === ['actorRole','actorUserId','address','bindingSha256','cookieFile','environmentId','expiresAt','kind','ownerReceipt','registration','requestSha256','resourceId','responseStatus','runId','schemaVersion','shownOnce','workspaceId'].filter(key => key !== 'ownerReceipt').sort().join(','), 'consent-facts-schema-keys');
    const ownerReceiptBody = { ...consentFacts, cookieFile, issuanceIntent,
      targetOwnerReceipt: targetFacts.ownerReceipt, authOwnerReceipt: authOwnerFacts.ownerReceipt,
      coordinatorPinSha256: canonicalSha256(coordinatorPin), actualReadbacks: { workspaceAdmin: true,
        membershipAdmin: true, environmentProjectJoin: true, environmentCreatedAfterEpoch: true,
        resourceCreatedAfterEpoch: true, sameOriginConsent: true, routeBindingEchoed: false },
      secrets: 'not_recorded', cleanup: 'owned-by-outer-r17-child' };
    const ownerReceipt = writePrivate(owner.privateRoot, `j4-consent-${binding.runId}.private.json`,
      Buffer.from(`${JSON.stringify(ownerReceiptBody, null, 2)}\n`, 'utf8'));
    consentFacts.ownerReceipt = ownerReceipt;
    return { consentFacts: Object.freeze(consentFacts), privateTokenHandle };
  } catch {
    const error = new Error('j4-a1:consent-issuance-uncertain-retain-owned-state');
    Object.defineProperty(error, 'a1Custody', { enumerable: false, value: Object.freeze({
      issuanceIntent, issuanceStatus, privateTokenHandle, tokenJoin, cookieFile,
      runId: binding.runId, bindingSha256: binding.bindingSha256,
      retention: 'outer-r17-must-retain-until-token-consumed-or-expiry-and-owner-reconciliation',
    }) });
    throw error;
  }
}

/** A3 may consume the one-shot opaque handle; raw token is never a receipt field. */
export function consumePrivateToken(handle, expected) {
  const item = TOKEN_HANDLES.get(handle);
  need(item && !item.consumed && item.runId === expected.runId && item.bindingSha256 === expected.bindingSha256
    && item.workspaceId === expected.workspaceId && item.environmentId === expected.environmentId
    && item.address === expected.address && item.expiresAt === expected.expiresAt, 'token-handle-join');
  item.consumed = true;
  TOKEN_HANDLES.delete(handle);
  return item.token;
}
