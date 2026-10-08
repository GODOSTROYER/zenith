import { test } from '@playwright/test';
import { receipt, writeReceipt } from './receipt.mjs';
import {
  Config, ensure, nonce, pause, privateFile, prerequisites, operator, login,
  jsonRequest, browserRequest, ok, action, until, kubeconfig, linkedAgent, mcp,
  kindReadback, adminHeaders, command,
} from './support.mjs';
import { Machine } from './engines.mjs';
import { enrollOperator } from './mfa.mjs';

// Collection (--list) never reads a credential/config or starts an engine.
test.skip(process.env.ZENITH_DEFAULT_JOURNEY !== '1', 'needs ZENITH_DEFAULT_JOURNEY=1, J1 stack, Mailpit, kind and Chromium');

test('default operated browser, REST, MCP and customer machine journey', async ({ browser }) => {
  let source = {}, stack, config, a, b, machine, linked, workspaceId, project, environmentId;
  const users = [], facts = [], readbacks = {};
  const runId = nonce(), witnessNonce = nonce(), serviceId = 'witness';
  const step = async (id, work) => {
    try { await test.step(id, work); facts.push({ id, status: 'passed' }); }
    catch { facts.push({ id, status: 'failed' }); throw new Error('journey:' + id); }
  };
  const getDetail = async operationId => ok(await browserRequest(a, '/api/platform/v1/operations/' + operationId, undefined, 'GET', workspaceId));
  const approvalBody = detail => ({
    proposalDigest: detail.operation.proposalDigest,
    ...(detail.operation.planDigest ? { planDigest: detail.operation.planDigest } : {}),
    ...(detail.planReview?.semantics?.digest ? { semanticsDigest: detail.planReview.semantics.digest } : {}),
  });
  const approve = async (operationId, checkSelf = false) => {
    const detail = await getDetail(operationId);
    ensure(detail.operation.status === 'awaiting_approval' && detail.decision?.approval?.separationOfDuties === true, 'independent-approval-required');
    if (checkSelf) {
      const self = await browserRequest(a, '/api/platform/v1/operations/' + operationId + '/approve', approvalBody(detail), 'POST', workspaceId);
      ensure(self.status === 403 && self.data.error?.code === 'separation_of_duties', 'self-approval-not-refused');
    }
    await b.goto(stack.apiUrl + '/platform/operations/' + operationId);
    // The actual UI carries the server-authored reviewed digests. No request interception.
    const response = b.waitForResponse(value => value.url().endsWith('/operations/' + operationId + '/approve') && value.request().method() === 'POST');
    await b.getByRole('button', { name: /^Approve / }).click();
    const recorded = await response;
    ensure(recorded.ok() && (await recorded.json()).operation?.status === 'approved', 'browser-approval-refused');
    const approved = await getDetail(operationId);
    ensure(approved.approvals.some(value => value.approverId === users[1] && value.decision === 'approve'), 'operator-b-approval');
    return approved;
  };
  const scale = async (surface, replicas) => {
    const key = nonce(), scope = { workspaceId, projectId: project.id, environmentId, resourceId: serviceId };
    let operationId;
    if (surface === 'rest') {
      const result = ok(await jsonRequest(stack.apiUrl + '/api/platform/v1/capabilities/propose', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, 'x-zenith-workspace': workspaceId },
        body: { capability: 'service.scale', scope, input: { operation: 'scale', serviceId, replicas }, idempotencyKey: key },
      }));
      ensure(result.operation.status === 'awaiting_approval', 'rest-proposal-gate');
      operationId = result.operation.id;
    } else {
      const result = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_scale_service',
        arguments: { target: { workspaceId, projectId: project.id, environmentId }, serviceId, replicas, idempotencyKey: key } });
      ensure(result.data.status === 'awaiting_approval' && result.data.executed === false, 'mcp-proposal-gate');
      operationId = result.data.operationId;
    }
    await approve(operationId, true);
    await mcp(stack, linked.token, 'tools/call', { name: 'zenith_execute_approved_operation',
      arguments: { workspaceId, operationId, expectedDigest: (await getDetail(operationId)).operation.proposalDigest } });
    const terminal = await until(() => getDetail(operationId),
      value => ['succeeded', 'failed', 'denied', 'uncertain', 'cancelled', 'expired'].includes(value.operation.status));
    ensure(terminal.operation.status === 'succeeded', 'scale-terminal-outcome');
    return { operationId };
  };
  let failed = false;
  try {
    await step('prerequisites', async () => {
      source = JSON.parse(privateFile(process.env.ZENITH_JOURNEY_SOURCE));
      config = Config.parse(JSON.parse(privateFile(process.env.ZENITH_JOURNEY_CONFIG)));
      stack = await prerequisites(config, source);
      Object.assign(source, { docker: stack.docker, dockerArch: stack.dockerArch });
      kubeconfig(config.kind.kubeconfigFile, config);
      const rotation = kubeconfig(config.kind.rotationKubeconfigFile, config);
      ensure(rotation.text !== privateFile(config.kind.kubeconfigFile), 'rotation-distinct-credential');
      privateFile(config.kind.observerKubeconfigFile);
      a = await (await browser.newContext()).newPage();
      b = await (await browser.newContext()).newPage();
    });
    await step('auth-admin-mailpit', async () => {
      const operatorA = await operator(stack, config.mailpitUrl, 'a', users);
      const operatorB = await operator(stack, config.mailpitUrl, 'b', users);
      ensure(operatorA.id !== operatorB.id, 'independent-identities');
      await login(a, stack, operatorA); await login(b, stack, operatorB);
      await enrollOperator(a, stack); await enrollOperator(b, stack);
    });
    await step('two-operator-workspace', async () => {
      const workspace = ok(await browserRequest(a, '/api/workspace', { name: 'Zenith J2 ' + runId })).workspace;
      workspaceId = workspace.id;
      const userB = ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users/' + users[1], { headers: adminHeaders(stack) }));
      const invite = ok(await browserRequest(a, '/api/workspace/invites', { email: userB.email, role: 'admin', workspaceId })).invite;
      const accepted = ok(await browserRequest(b, '/api/workspace/invites/' + invite.id + '/accept', {}));
      ensure(accepted.member?.id === users[1] && accepted.member?.role === 'admin', 'operator-b-membership');
      const created = await action(a, 'project.create', { name: 'J2 witness ' + runId, withEnvironment: false });
      project = { id: created.projectId, slug: created.slug, name: 'J2 witness ' + runId };
      const manifest = { version: 2, placement: { provider: 'kubernetes', regions: ['in-cluster'] },
        providerConfig: { kubernetes: { namespace: config.kind.namespace } }, services: [{ id: serviceId, name: 'witness', kind: 'web',
        source: { type: 'image', image: config.kind.image }, size: 'small', replicas: 1, port: 8080,
        healthPath: '/', ownership: 'managed', env: [{ key: 'WITNESS_NONCE', value: witnessNonce }] }],
        resources: [], routes: [], bindings: [] };
      await action(a, 'project.updateManifest', { projectId: project.id, manifest });
      // Store genuine LOCAL kind credentials through the existing tenant vault action,
      // then remove their temporary product env references before any revision/deploy.
      for (const [key, file] of [['J2_OLD_KUBE', config.kind.kubeconfigFile], ['J2_NEW_KUBE', config.kind.rotationKubeconfigFile]]) {
        await action(a, 'system.setSecret', { projectId: project.id, serviceId, key, secretRef: 'vault:' + key, secretValue: privateFile(file) });
      }
      await action(a, 'project.updateManifest', { projectId: project.id, manifest });
      const target = kubeconfig(config.kind.kubeconfigFile, config);
      const connection = await action(a, 'connection.createKubernetes', { label: 'J2 kind ' + runId, server: config.kind.server,
        caData: target.caData, namespaces: [config.kind.namespace], credentialRef: 'vault:J2_OLD_KUBE', scopedGuest: false });
      project.connectionId = connection.connectionId;
      await a.goto(stack.apiUrl + '/platform/connections');
      const card = a.getByRole('listitem').filter({ hasText: 'J2 kind ' + runId });
      const verified = a.waitForResponse(value => value.url().endsWith('/connections/' + project.connectionId + '/verify') && value.request().method() === 'POST');
      await card.getByRole('button', { name: 'Verify', exact: true }).click();
      ensure((await verified).ok(), 'connection-verification');
      const env = await action(a, 'env.create', { projectId: project.id, name: 'production', class: 'production',
        connectionId: project.connectionId, approvalRequired: true });
      environmentId = env.environmentId;
      linked = await linkedAgent(a, stack, project, workspaceId);
    });
    let operationId, deploymentId;
    await step('browser-proposal', async () => {
      await a.goto(stack.apiUrl + '/p/' + project.slug + '/system?env=' + environmentId);
      await a.getByRole('button', { name: /pending change.*Review/ }).click();
      await a.getByLabel('Type production to confirm deploying to production', { exact: true }).fill('production');
      const response = a.waitForResponse(value => value.url().endsWith('/api/actions/deploy.apply') && value.request().method() === 'POST');
      await a.getByRole('button', { name: 'Request approval for production', exact: true }).click();
      const answer = await (await response).json();
      const data = answer.result?.data;
      ensure(answer.result?.ok && data?.deploymentId && data?.operationId, 'default-browser-workflow-proposal');
      operationId = data.operationId; deploymentId = data.deploymentId;
      const detail = await getDetail(operationId);
      ensure(detail.operation.status === 'awaiting_approval' && detail.operation.principal.id === users[0], 'browser-requester');
    });
    await step('self-approval-refused', async () => {
      const detail = await getDetail(operationId);
      const response = await browserRequest(a, '/api/platform/v1/operations/' + operationId + '/approve', approvalBody(detail), 'POST', workspaceId);
      ensure(response.status === 403 && response.data.error?.code === 'separation_of_duties', 'self-approval');
      await a.goto(stack.apiUrl + '/platform/operations/' + operationId);
      ensure(await a.getByRole('button', { name: /^Approve / }).isDisabled(), 'self-ui-approval');
    });
    await step('bearer-approval-refused', async () => {
      const response = await jsonRequest(stack.apiUrl + '/api/platform/v1/operations/' + operationId + '/approve', {
        method: 'POST', headers: { authorization: 'Bearer ' + linked.token, origin: stack.apiUrl, 'x-zenith-workspace': workspaceId },
        body: approvalBody(await getDetail(operationId)),
      });
      ensure([401, 403].includes(response.status), 'bearer-human-approval');
      ensure((await getDetail(operationId)).operation.status === 'awaiting_approval', 'bearer-approval-changed-state');
    });
    await step('stale-semantics-refused', async () => {
      await approve(operationId);
      // The product's existing deployment caller owns workflow startup.
      await action(b, 'deploy.approve', { deploymentId }, { projectId: project.id, environmentId });
      const detail = await until(() => getDetail(operationId),
        value => value.operation.status === 'awaiting_approval' && value.operation.approvalRound > 0);
      const body = approvalBody(detail);
      ensure(/^[a-f0-9]{64}$/.test(body.planDigest ?? '') && /^[a-f0-9]{64}$/.test(body.semanticsDigest ?? ''), 'plan-and-semantics-required');
      const wrong = body.semanticsDigest[0] === '0' ? '1' : '0';
      const response = await browserRequest(b, '/api/platform/v1/operations/' + operationId + '/approve',
        { ...body, semanticsDigest: wrong + body.semanticsDigest.slice(1) }, 'POST', workspaceId);
      ensure(response.status === 409 && response.data.error?.code === 'semantics_mismatch', 'stale-semantics-approval');
      ensure((await getDetail(operationId)).operation.status === 'awaiting_approval', 'stale-semantics-changed-state');
    });
    await step('browser-kind-execution-readback', async () => {
      await approve(operationId, true);
      const detail = await until(() => getDetail(operationId), value => ['succeeded', 'failed', 'uncertain'].includes(value.operation.status));
      ensure(detail.operation.status === 'succeeded', 'default-browser-execution');
      readbacks.kind = await kindReadback(config, 1, witnessNonce);
    });
    await step('rest-proposal-execution-readback', async () => {
      await scale('rest', 2); readbacks.kind = await kindReadback(config, 2, witnessNonce);
    });
    await step('mcp-proposal-execution-readback', async () => {
      await scale('mcp', 1); readbacks.kind = await kindReadback(config, 1, witnessNonce);
    });
    let machineEnv;
    await step('machine-browser-consent', async () => {
      machineEnv = (await action(a, 'env.create', { projectId: project.id, name: 'machine', class: 'staging',
        connectionId: project.connectionId, approvalRequired: true })).environmentId;
      // Enrollment currently has an admin API, not a UI form. Exercise the real
      // same-origin browser consent API and verify the resulting saved binding.
      const token = ok(await browserRequest(a, '/api/platform/v1/runners/tokens', {
        kind: 'machine', ttlMinutes: 10, binding: { environmentId: machineEnv, address: 'service/witness' },
      }, 'POST', workspaceId));
      ensure(token.shownOnce && token.workspaceId === workspaceId, 'enrollment-consent');
      machine = new Machine(config, stack, runId);
      await machine.start(token.token, machineEnv, 'service/witness');
      await machine.registered(a, workspaceId);
    });
    await step('machine-independent-approval-readback', async () => {
      const runbookId = 'j2-' + runId, target = { transport: 'zenithd', targetId: machine.id,
        environmentId: machineEnv, resourceId: serviceId, address: 'service/witness' };
      const published = ok(await browserRequest(a, '/api/platform/v1/runbooks', { runbookId,
        definition: { schemaVersion: 1, name: 'J2 witness', steps: [{ id: 'write', title: 'Write owned witness marker',
          operation: 'machine.exec', args: { argv: ['/usr/local/bin/witness', 'write', witnessNonce], timeoutSec: 10 },
          timeoutSec: 15, maxOutputBytes: 4096, onFailure: 'abort' }] },
      }, 'POST', workspaceId));
      ensure(published.version?.definitionDigest, 'signed-runbook');
      const run = ok(await browserRequest(a, '/api/platform/v1/runbooks/' + runbookId + '/runs',
        { targets: [target], maxParallelTargets: 1, maxRunDurationSec: 120 }, 'POST', workspaceId)).run;
      ensure(run.status === 'pending_approval', 'machine-run-approval-required');
      const self = await browserRequest(a, '/api/platform/v1/runbooks/runs/' + run.id + '/approve',
        { bindingDigest: run.bindingDigest }, 'POST', workspaceId);
      ensure(self.status === 403, 'machine-run-self-approval');
      await b.goto(stack.apiUrl + '/platform/runbooks/runs/' + run.id);
      const approved = b.waitForResponse(value => value.url().endsWith('/runbooks/runs/' + run.id + '/approve') && value.request().method() === 'POST');
      await b.getByRole('button', { name: 'Approve this run', exact: true }).click();
      ensure((await approved).ok(), 'machine-ui-approval');
      const complete = await until(async () => ok(await browserRequest(a, '/api/platform/v1/runbooks/runs/' + run.id, undefined, 'GET', workspaceId)),
        value => ['succeeded', 'failed', 'uncertain', 'expired'].includes(value.run.status));
      ensure(complete.run.status === 'succeeded' && complete.steps.length === 1 && complete.steps[0].status === 'succeeded', 'machine-run-success');
      readbacks.machine = await machine.read(witnessNonce);
      const events = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_get_operation_events',
        arguments: { workspaceId, operationId: complete.steps[0].operationId } });
      ensure(events.data.count > 0 && events.data.events?.length > 0, 'machine-events-readback-empty');
      ensure(!JSON.stringify(events).includes(machine.credential), 'model-visible-credential');
    });
    await step('customer-credential-absence', async () => {
      await machine.credentialAbsent(process.env.ZENITH_JOURNEY_SCRATCH);
    });
    await step('connection-rotation-readback', async () => {
      const rotated = ok(await browserRequest(b, '/api/platform/v1/connections/' + project.connectionId + '/rotate',
        { patch: { credentialRef: 'vault:J2_NEW_KUBE' }, promote: false }, 'POST', workspaceId));
      ensure(rotated.ok && rotated.data?.status === 'verified' && rotated.data?.verified === true, 'rotation-candidate-verification');
      const rotationId = rotated.data.rotationId;
      ok(await browserRequest(b, '/api/platform/v1/connections/' + project.connectionId + '/rotation/promote',
        { rotationId }, 'POST', workspaceId));
      // Destroy ONLY the named old local fixture identity. New traffic must use
      // the rotated credential; a successful response alone cannot prove it.
      await command('kubectl', ['--kubeconfig', config.kind.observerKubeconfigFile, '--context', config.kind.context,
        '-n', config.kind.namespace, 'delete', 'serviceaccount', 'j2-deployer-old']);
      await scale('mcp', 2); readbacks.rotatedKind = await kindReadback(config, 2, witnessNonce);
    });
    await step('connection-revocation-no-fallback', async () => {
      const pending = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_scale_service',
        arguments: { target: { workspaceId, projectId: project.id, environmentId }, serviceId, replicas: 1, idempotencyKey: nonce() } });
      await approve(pending.data.operationId, true);
      await b.goto(stack.apiUrl + '/platform/connections');
      const card = b.getByRole('listitem').filter({ hasText: 'J2 kind ' + runId });
      await card.getByRole('button', { name: 'Revoke', exact: true }).click();
      await card.getByLabel('Type the connection id to confirm', { exact: true }).fill(project.connectionId);
      const revoked = b.waitForResponse(value => value.url().endsWith('/connections/' + project.connectionId + '/revoke') && value.request().method() === 'POST');
      await card.getByRole('button', { name: 'Revoke connection', exact: true }).click();
      const revokedResponse = await revoked;
      ensure(revokedResponse.ok() && (await revokedResponse.json()).ok === true, 'connection-browser-revocation');
      const connection = ok(await browserRequest(a, '/api/platform/v1/connections/' + project.connectionId,
        undefined, 'GET', workspaceId)).connection;
      ensure(connection.status === 'revoked' && connection.revokedAt, 'connection-terminal-revocation');
      const execute = await mcp(stack, linked.token, 'tools/call', { name: 'zenith_execute_approved_operation',
        arguments: { workspaceId, operationId: pending.data.operationId, expectedDigest: pending.data.proposalDigest } }, true);
      const envelope = execute.data?.result?.structuredContent;
      ensure(execute.status < 500 && !execute.data?.error, 'revocation-engine-or-protocol-failure');
      if (execute.status >= 400 || execute.data?.result?.isError || envelope?.ok === false) {
        ensure(envelope?.ok === false && ['connection_revoked', 'connection_unavailable', 'binding_revoked'].includes(envelope.error?.code),
          'revocation-authority-refusal-required');
      } else {
        ensure(envelope?.ok === true && envelope.simulated === false && envelope.truncated === false &&
          envelope.unavailable?.length === 0 && envelope.data?.workflow?.id, 'revocation-real-workflow-required');
        const terminal = await until(() => getDetail(pending.data.operationId),
          value => ['failed', 'uncertain', 'succeeded'].includes(value.operation.status));
        ensure(terminal.operation.status === 'failed' && /no usable provider connection|connection.*revoked|binding.*revoked/i.test(terminal.operation.error ?? ''),
          'revocation-dispatch-terminal');
      }
      await pause(2000);
      await kindReadback(config, 2, witnessNonce);
      const verify = await browserRequest(a, '/api/platform/v1/connections/' + project.connectionId + '/verify', {}, 'POST', workspaceId);
      ensure(verify.status < 500 && verify.data.ok === false && /revoked/i.test(verify.data.error ?? ''), 'revoked-verification');
      ok(await browserRequest(b, '/api/platform/v1/machines/' + machine.id + '/revoke', {}, 'POST', workspaceId));
      await until(async () => JSON.parse(await command('docker', ['inspect', machine.container])),
        value => value[0].State.Running === false);
    });
  } catch { failed = true; }
  finally {
    try {
      await step('cleanup', async () => {
        if (machine) await machine.cleanup();
        if (linked && a) ok(await browserRequest(a, '/api/integrations/agent/link/revoke', { credentialId: linked.credentialId }));
        for (const id of users) ok(await jsonRequest(stack.supabaseUrl + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: adminHeaders(stack) }));
        if (a) await a.context().close(); if (b) await b.context().close();
      });
    } catch { failed = true; }
    const result = { ...source, checks: facts, readbacks };
    if (process.env.ZENITH_JOURNEY_RECEIPT) writeReceipt(process.env.ZENITH_JOURNEY_RECEIPT, result);
    ensure(!failed && receipt(result).status === 'passed', 'journey-incomplete');
  }
});
