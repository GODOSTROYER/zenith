# Workflow start intent engine fixtures

Source branch: `ws/prod-intent-engine-fixtures-20261003`

Source base: `b9ab5743fd0a69b39e70488cfa713d713b4591d7`

This change prepares genuine Temporal CLI fixture corrections in `tests/workflows/start-intent.test.ts`. No runtime checks were run in this source lane. The original exact-base report remains retained: 151 passed, five failed, zero skipped. All 27 transport, 21 supplementary wire-model and three admission cases retain their titles; production confirmation, durable SQL authority, the canonical 141 required workflow-intent cases, shared support and historical replay fixtures are unchanged.

The file starts its own installed CLI through SDK 1.24 `TestWorkflowEnvironment.createLocal`, on loopback and a random nondefault port with a unique namespace. It supplies only the supported dev-server argument `--dynamic-config-value frontend.WorkflowTimeSkippingEnabled=true`. Missing CLI fails required runs. It does not attach to an ambient server, download a server or change the Java time-skipping replay environment. Its worker/bundle setup uses the existing shared harness and tears down its owned server.

Temporal CLI 1.9.1 embeds server 1.32.0. The immutable [CLI flag declaration](https://raw.githubusercontent.com/temporalio/cli/1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde/internal/temporalcli/commands.gen.go), [CLI flag application](https://raw.githubusercontent.com/temporalio/cli/1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde/internal/temporalcli/commands.server.go) and [server namespace setting](https://raw.githubusercontent.com/temporalio/temporal/d94e34a1ebba5410a2e7d07119a76896909591aa/common/dynamicconfig/constants.go) establish that feature setting. These are test-server settings, not hosted product configuration.

The pinned [frontend](https://raw.githubusercontent.com/temporalio/temporal/d94e34a1ebba5410a2e7d07119a76896909591aa/service/frontend/workflow_handler.go) fills an unset or nonpositive `maxSessionSkipCount` with at least one, using its default 200, including an explicitly disabled config. The [history event factory](https://raw.githubusercontent.com/temporalio/temporal/d94e34a1ebba5410a2e7d07119a76896909591aa/service/history/historybuilder/event_factory.go) records that populated request. The genuine positive uses explicit default parentless priority and an absent raw time-skipping config, which expresses disabled default behavior. It asserts raw absence before confirming the same run. A fresh, separate owning operation in that case sends explicit false/zero, asserts the actual raw value 200 and requires uncertainty with the retained attempted tombstone and zero additional Start RPCs. The three other genuine time-skipping requests assert raw field presence and actual populated counts before refusing confirmation. No history response is rewritten for these cases.

Closed-run deletion is asynchronous: the [delete API](https://raw.githubusercontent.com/temporalio/temporal/d94e34a1ebba5410a2e7d07119a76896909591aa/service/history/api/deleteworkflow/api.go) queues a [delete task](https://raw.githubusercontent.com/temporalio/temporal/d94e34a1ebba5410a2e7d07119a76896909591aa/service/history/deletemanager/delete_manager.go). The fixture verifies this exact run exists through the independent reader before its sole delete request. A bounded 30-second wait requires both SDK Describe's typed workflow-not-found error and raw History's exact gRPC NOT_FOUND response, on the same exact run, while DescribeNamespace still verifies the owning namespace. Each polling round has a two-second RPC deadline within the overall deadline. Other errors and deadline exhaustion fail. Request acceptance alone, an empty history, a missing namespace or a single absent read cannot pass. The acknowledged SQL run tombstone must survive, recovery remains uncertain and no additional Start may be sent.

Root must run the canonical gate on a fresh owned PostgreSQL database, committed OPA assets, pinned Node 22.23.3 and checksum-verified CLI 1.9.1, then independently revalidate its actual execution receipt:

```sh
node scripts/ci/run-gate.mjs workflow-intents --run
node scripts/ci/run-gate.mjs workflow-intents --validate .data-ci-lane/workflow-intents-lane.json --require-execution
```

The canonical manifest supplies the required test flags and exact report requirements. Source review and prepared assertions do not establish runtime success, natural retention expiry, hosted namespace access, live product membership or provider execution.
