# Capability matrix

<!-- GENERATED FILE: DO NOT EDIT. Source: scripts/docs/capability-matrix.ts. Regenerate: npx tsx scripts/docs/capability-matrix.ts -->

This file is generated from the code: the resource drivers (the runtime registry
and the driver group modules), the observability evidence table and the capability
catalog. It is never written by
hand. To refresh it after a driver merges or an evidence level changes, run
`npx tsx scripts/docs/capability-matrix.ts`; `--check` exits non-zero when the
committed file is out of date, and `tests/docs/capability-matrix.test.ts` runs it.

What the matrix is: what each driver *declares*. The generator cross-checks each
declaration against the driver's shape (see [Problems](#problems)), but it cannot
verify that a level is true. A label is only as good as the test or run behind it.

## Evidence levels

| Level | Meaning | Evidence that backs it |
|---|---|---|
| `real` | Exercised against the real provider in a live acceptance run. | A recorded live run with real credentials, started by hand through the dispatch-only workflow `.github/workflows/live-acceptance.yml`. **No such run exists yet.** |
| `emulated` | Exercised against an emulator (LocalStack, kind, PGlite). | A recorded run against that emulator. |
| `contract` | Only mocked SDK or HTTP contract tests. | Unit tests with `aws-sdk-client-mock`, fake clients or a local fake HTTP server. Shows the code matches the documented API shape, nothing about a real account. |
| `simulated` | Generated data; nothing outside Zenith was inspected. | The sandbox. Never presented as real. |

A cell reading **undeclared** means the driver supports the operation but declares no valid evidence level for it; that is listed under [Problems](#problems). A dash means the driver does not support that operation.

## Status on this branch

No entry claims `real`: there is no live-account acceptance evidence yet.

| Provider | Provider-level drivers index | Driver group modules | Drivers merged | Registered by the app | Registrable, not registered | Module only |
|---|---|---|---|---|---|---|
| aws | `src/lib/providers/aws/drivers/index.ts` | `compute`, `data`, `network` | 21 | 21 | 0 | 0 |
| gcp | `src/lib/providers/gcp/drivers/index.ts` | `build`, `compute`, `data`, `edge`, `identity`, `network`, `observability` | 18 | 18 | 0 | 0 |
| azure | `src/lib/providers/azure/drivers/index.ts` | `compute`, `data`, `dns`, `identity`, `network`, `platform` | 19 | 19 | 0 | 0 |
| oci | `src/lib/providers/oci/drivers/index.ts` | `compute`, `data`, `edge`, `network`, `platform` | 20 | 20 | 0 | 0 |
| kubernetes | `src/lib/providers/kubernetes/drivers/index.ts` | `identity`, `network`, `storage`, `workload` | 11 | 11 | 0 | 0 |
| zenith | `src/lib/providers/zenith/drivers/index.ts` | none | 12 | 12 | 0 | 0 |
| sandbox | none | none | none | none | none | none |
| localstack | none | none | none | none | none | none |

**No resource drivers are merged yet for:** sandbox, localstack. Driver sets are delivered by separate workstreams and appear here once they are merged and this file is regenerated.

This matrix covers the **resource-driver** path (`src/lib/drivers`). The product engine's sandbox, LocalStack and AWS Preview providers use the older `ProviderAdapter` interface and have no per-operation evidence table; their honest status is in [`docs/LIMITATIONS.md`](../LIMITATIONS.md#providers).

## Resource drivers: provider × native type × operation

### aws

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `aws:acm_certificate` | `tls_certificate` | `aws.acm_certificate@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:alb` | `load_balancer` | `aws.alb@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `aws:cloudwatch_log_group` | `log_group` | `aws.cloudwatch_log_group@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:codebuild_project` | `build_pipeline` | `aws.codebuild_project@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:ec2_instance` | `compute_instance` | `aws.ec2_instance@1` (experimental) | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `aws:ecr_repository` | `container_registry` | `aws.ecr_repository@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:ecs_scheduled_task` | `scheduled_job` | `aws.ecs_scheduled_task@1` | yes | `contract` | `contract` | `contract` | `contract` | — | — |
| `aws:ecs_service` | `container_service` | `aws.ecs_service@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `deployment.deploy`: `contract`<br>`service.restart`: `contract`<br>`service.scale`: `contract` |
| `aws:elasticache_replication_group` | `redis` | `aws.elasticache_replication_group@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `aws:iam_role` | `identity` | `aws.iam_role@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:lambda_function` | `function` | `aws.lambda_function@1` (experimental) | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `function.invoke`: `contract` |
| `aws:rds_instance` | `postgres` | `aws.rds_instance@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `database.snapshot`: `contract` |
| `aws:route53_record` | `dns_record` | `aws.route53_record@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `aws:route53_zone` | `dns_zone` | `aws.route53_zone@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:s3_bucket` | `object_store` | `aws.s3_bucket@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:s3_static_site` | `static_site` | `aws.s3_static_site@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `aws:secretsmanager_secret` | `secret` | `aws.secretsmanager_secret@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:security_group_rule` | `firewall` | `aws.security_group_rule@1` | yes | `contract` | `contract` | — | `contract` | `contract` | `firewall.inspect`: `contract` |
| `aws:sqs_queue` | `queue` | `aws.sqs_queue@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `aws:subnet` | `subnet` | `aws.subnet@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `aws:vpc` | `network` | `aws.vpc@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |

### gcp

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `gcp:artifact_registry_repository` | `container_registry` | `gcp.artifact_registry_repository@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:cloud_build_trigger` | `build_pipeline` | `gcp.cloud_build_trigger@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `gcp:cloud_run_job` | `scheduled_job` | `gcp.cloud_run_job@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `gcp:cloud_run_service` | `container_service` | `gcp.cloud_run_service@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `service.restart`: `contract`<br>`service.scale`: `contract` |
| `gcp:cloud_sql_instance` | `postgres` | `gcp.cloud_sql_instance@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `database.snapshot`: `contract` |
| `gcp:dns_managed_zone` | `dns_zone` | `gcp.dns_managed_zone@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:dns_record_set` | `dns_record` | `gcp.dns_record_set@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `gcp:firewall_rule` | `firewall` | `gcp.firewall_rule@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:global_http_lb` | `load_balancer` | `gcp.global_http_lb@1` | yes | `contract` | `contract` | `contract` | `contract` | — | — |
| `gcp:log_bucket` | `log_group` | `gcp.log_bucket@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `gcp:managed_ssl_certificate` | `tls_certificate` | `gcp.managed_ssl_certificate@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `gcp:memorystore_instance` | `redis` | `gcp.memorystore_instance@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `gcp:pubsub_topic` | `queue` | `gcp.pubsub_topic@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:secret_manager_secret` | `secret` | `gcp.secret_manager_secret@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:service_account` | `identity` | `gcp.service_account@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:storage_bucket` | `object_store` | `gcp.storage_bucket@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:subnetwork` | `subnet` | `gcp.subnetwork@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `gcp:vpc_network` | `network` | `gcp.vpc_network@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |

### azure

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `azure:acr_task` | `build_pipeline` | `azure.acr_task@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `azure:application_gateway` | `load_balancer` | `azure.application_gateway@1` | yes | `contract` | `contract` | `contract` | `contract` | — | — |
| `azure:container_app` | `container_service` | `azure.container_app@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `service.restart`: `contract`<br>`service.scale`: `contract` |
| `azure:container_app_job` | `scheduled_job` | `azure.container_app_job@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `azure:container_registry` | `container_registry` | `azure.container_registry@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:dns_record_set` | `dns_record` | `azure.dns_record_set@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `azure:dns_zone` | `dns_zone` | `azure.dns_zone@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:key_vault_secret` | `secret` | `azure.key_vault_secret@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:log_analytics_workspace` | `log_group` | `azure.log_analytics_workspace@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:managed_certificate` | `tls_certificate` | `azure.managed_certificate@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `azure:network_security_rule` | `firewall` | `azure.network_security_rule@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `azure:postgresql_flexible_server` | `postgres` | `azure.postgresql_flexible_server@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `database.snapshot`: `contract` |
| `azure:redis_cache` | `redis` | `azure.redis_cache@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `azure:service_bus_queue` | `queue` | `azure.service_bus_queue@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `azure:service_bus_topic` | `pubsub` | `azure.service_bus_topic@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `azure:storage_container` | `object_store` | `azure.storage_container@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:subnet` | `subnet` | `azure.subnet@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `azure:user_assigned_identity` | `identity` | `azure.user_assigned_identity@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `azure:virtual_network` | `network` | `azure.virtual_network@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |

### oci

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `oci:block_volume` | `volume` | `oci.block_volume@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:certificate` | `tls_certificate` | `oci.certificate@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:compute_instance` | `compute_instance` | `oci.compute_instance@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `oci:container_instance` | `container_service` | `oci.container_instance@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `service.restart`: `contract` |
| `oci:container_repository` | `container_registry` | `oci.container_repository@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:dns_rrset` | `dns_record` | `oci.dns_rrset@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `oci:dns_zone` | `dns_zone` | `oci.dns_zone@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:dynamic_group` | `identity` | `oci.dynamic_group@1` | yes | `contract` | `contract` | — | `contract` | — | — |
| `oci:load_balancer` | `load_balancer` | `oci.load_balancer@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `oci:log_group` | `log_group` | `oci.log_group@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:mysql_db_system` | `mysql` | `oci.mysql_db_system@1` | yes | — | `contract` | `contract` | `contract` | `contract` | — |
| `oci:object_storage_bucket` | `object_store` | `oci.object_storage_bucket@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:oke_cluster` | `kubernetes_cluster` | `oci.oke_cluster@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `oci:postgresql_db_system` | `postgres` | `oci.postgresql_db_system@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | `database.snapshot`: `contract` |
| `oci:queue` | `queue` | `oci.queue@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `oci:redis_cluster` | `redis` | `oci.redis_cluster@1` | yes | `contract` | `contract` | `contract` | `contract` | `contract` | — |
| `oci:security_list_rule` | `firewall` | `oci.security_list_rule@1` | yes | `contract` | `contract` | — | `contract` | — | `firewall.inspect`: `contract` |
| `oci:subnet` | `subnet` | `oci.subnet@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |
| `oci:vault_secret` | `secret` | `oci.vault_secret@1` | yes | `contract` | `contract` | — | `contract` | `contract` | `secret.write`: `contract` |
| `oci:vcn` | `network` | `oci.vcn@1` | yes | `contract` | `contract` | — | `contract` | `contract` | — |

### kubernetes

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `k8s:Certificate` | `tls_certificate` | `kubernetes.certificate@1` | yes | — | `contract` | `contract` | `contract` | `contract` | — |
| `k8s:CronJob` | `scheduled_job` | `kubernetes.cronjob@1` | yes | — | `contract` | `contract` | `contract` | `contract` | `events.read`: `contract` |
| `k8s:DNSEndpoint` | `dns_record` | `kubernetes.dnsendpoint@1` | yes | — | `contract` | — | `contract` | `contract` | — |
| `k8s:Deployment` | `container_service` | `kubernetes.deployment@1` | yes | — | `contract` | `contract` | `contract` | `contract` | `container.logs`: `contract`<br>`deployment.rollback`: `contract`<br>`events.read`: `contract`<br>`service.restart`: `contract`<br>`service.scale`: `contract` |
| `k8s:Ingress` | `load_balancer` | `kubernetes.ingress@1` | yes | — | `contract` | `contract` | `contract` | `contract` | — |
| `k8s:Namespace` | `network` | `kubernetes.namespace@1` | yes | — | `contract` | `contract` | `contract` | `contract` | — |
| `k8s:NetworkPolicy` | `firewall` | `kubernetes.networkpolicy@1` | yes | — | `contract` | — | `contract` | `contract` | — |
| `k8s:PersistentVolumeClaim` | `volume` | `kubernetes.persistentvolumeclaim@1` | yes | — | `contract` | `contract` | `contract` | `contract` | — |
| `k8s:Secret` | `secret` | `kubernetes.secret@1` | yes | — | `contract` | — | `contract` | `contract` | — |
| `k8s:ServiceAccount` | `identity` | `kubernetes.serviceaccount@1` | yes | — | `contract` | — | `contract` | `contract` | — |
| `k8s:StatefulSet` | `postgres` | `kubernetes.statefulset@1` | yes | — | `contract` | `contract` | `contract` | `contract` | `container.logs`: `contract`<br>`events.read`: `contract`<br>`service.restart`: `contract` |

### zenith

| Native type | Kind | Driver | Registered | compile | observe | runtime | verify | discover | Day-two operations |
|---|---|---|---|---|---|---|---|---|---|
| `k8s:Certificate` | `tls_certificate` | `zenith.platform_tls@1` | yes | — | `contract` | — | `contract` | — | — |
| `k8s:CronJob` | `scheduled_job` | `zenith.cronjob@1` | yes | — | `contract` | `contract` | `contract` | — | `events.read`: `contract` |
| `k8s:DNSEndpoint` | `dns_record` | `zenith.platform_dns@1` | yes | — | `contract` | — | `contract` | — | — |
| `k8s:Deployment` | `container_service` | `zenith.deployment@1` | yes | — | `contract` | `contract` | `contract` | — | `container.logs`: `contract`<br>`deployment.rollback`: `contract`<br>`events.read`: `contract`<br>`service.restart`: `contract`<br>`service.scale`: `contract` |
| `k8s:Ingress` | `load_balancer` | `zenith.http_route@1` | yes | — | `contract` | `contract` | `contract` | — | — |
| `k8s:Namespace` | `network` | `zenith.tenant_namespace@1` | yes | — | `contract` | `contract` | `contract` | — | — |
| `k8s:NetworkPolicy` | `firewall` | `zenith.network_policy@1` | yes | — | `contract` | — | `contract` | — | — |
| `k8s:PersistentVolumeClaim` | `volume` | `zenith.persistentvolumeclaim@1` | yes | — | `contract` | `contract` | `contract` | — | — |
| `k8s:Secret` | `secret` | `zenith.secret@1` | yes | — | `contract` | — | `contract` | — | — |
| `k8s:ServiceAccount` | `identity` | `zenith.serviceaccount@1` | yes | — | `contract` | — | `contract` | — | — |
| `zenith:managed_postgres` | `postgres` | `zenith.managed_postgres@1` | yes | — | `contract` | `contract` | `contract` | — | — |
| `zenith:object_store` | `object_store` | `zenith.object_store@1` | yes | — | `contract` | — | `contract` | — | — |

## Refusal-only operations

These handlers decline execution. Their evidence covers refusal paths; they are excluded from executable provider support above and below.

| Driver | Refused operation | Refusal evidence |
|---|---|---|
| `aws.rds_instance@1` | `database.delete` | `contract` |
| `aws.rds_instance@1` | `database.restore` | `contract` |

## Observability sources

From `SOURCE_EVIDENCE` (`src/lib/observability/evidence.ts`). Sources are read-only query backends, not drivers.

| Source | Evidence | What backs it |
|---|---|---|
| `aws.cloudwatch-logs` | `contract` | aws-sdk-client-mock only (FilterLogEvents, StartQuery/GetQueryResults/StopQuery) |
| `aws.cloudwatch-metrics` | `contract` | aws-sdk-client-mock only (GetMetricData) |
| `aws.events` | `contract` | aws-sdk-client-mock only (ECS DescribeServices events and deployments) |
| `aws.health` | `contract` | aws-sdk-client-mock only (ECS DescribeServices/ListTasks/DescribeTasks, ELBv2 DescribeTargetHealth/DescribeTargetGroups/DescribeLoadBalancers, RDS DescribeDBInstances) |
| `kubernetes` | `contract` | fake CoreV1Api and KubeConfig; method names checked against the installed @kubernetes/client-node v2 |
| `loki` | `contract` | local fake HTTP server implementing /loki/api/v1/query_range |
| `prometheus` | `contract` | local fake HTTP server implementing /api/v1/query_range |
| `sandbox.logsim` | `simulated` | generated by @/lib/logsim from deployment records; exercised against the real logsim over a temp store |

## Capability catalog

From `CAPABILITIES` (`src/lib/capabilities/catalog.ts`): every name authorization can act on. **Default autonomy** is the minimum environment autonomy level at which the capability may run without a human approval, before policy ([ADR-0007](../adr/0007-capability-broker-and-autonomy.md), [POLICY.md](operations/POLICY.md)); `6` means never unattended. **Driver support** lists the providers whose merged drivers (registered or not) declare the capability as a native operation, at the *weakest* level among that provider's drivers. Many capabilities (planning, cost, placement, incident investigation) are not driver operations at all and will always read "no driver".

| Capability | Risk floor | Mutates | Flags | Default autonomy | Scope | Driver support |
|---|---|---|---|---|---|---|
| `container.inspect` | low | no | — | 0 | resource | no driver |
| `container.list` | low | no | — | 0 | resource | no driver |
| `container.logs` | low | no | — | 0 | resource | kubernetes: `contract` (2 drivers)<br>zenith: `contract` (1 driver) |
| `cost.estimate` | low | no | — | 0 | project | no driver |
| `events.read` | low | no | — | 0 | environment | kubernetes: `contract` (3 drivers)<br>zenith: `contract` (2 drivers) |
| `firewall.inspect` | low | no | — | 0 | environment | aws: `contract` (1 driver)<br>oci: `contract` (1 driver) |
| `incident.investigate` | low | no | — | 0 | environment | no driver |
| `infrastructure.observe` | low | no | — | 0 | environment | no driver |
| `logs.read` | low | no | — | 0 | environment | no driver |
| `machine.inspect` | low | no | — | 0 | resource | no driver |
| `metrics.read` | low | no | — | 0 | environment | no driver |
| `network.dnsCheck` | low | no | — | 0 | resource | no driver |
| `network.portCheck` | low | no | — | 0 | resource | no driver |
| `placement.solve` | low | no | — | 0 | project | no driver |
| `process.list` | low | no | — | 0 | resource | no driver |
| `service.status` | low | no | — | 0 | resource | no driver |
| `system.logs` | low | no | — | 0 | resource | no driver |
| `system.metrics` | low | no | — | 0 | resource | no driver |
| `topology.read` | low | no | — | 0 | project | no driver |
| `traces.read` | low | no | — | 0 | environment | no driver |
| `infrastructure.plan` | low | no | — | 1 | environment | no driver |
| `file.read` | medium | no | — | 2 | resource | no driver |
| `database.snapshot` | low | yes | — | 3 | resource | aws: `contract` (1 driver)<br>azure: `contract` (1 driver)<br>gcp: `contract` (1 driver)<br>oci: `contract` (1 driver) |
| `service.restart` | medium | yes | — | 3 | resource | aws: `contract` (1 driver)<br>azure: `contract` (1 driver)<br>gcp: `contract` (1 driver)<br>kubernetes: `contract` (2 drivers)<br>oci: `contract` (1 driver)<br>zenith: `contract` (1 driver) |
| `service.scale` | medium | yes | — | 3 | resource | aws: `contract` (1 driver)<br>azure: `contract` (1 driver)<br>gcp: `contract` (1 driver)<br>kubernetes: `contract` (1 driver)<br>zenith: `contract` (1 driver) |
| `database.migrate` | high | yes | — | 4 | resource | no driver |
| `deployment.deploy` | high | yes | — | 4 | environment | aws: `contract` (1 driver) |
| `deployment.rollback` | high | yes | — | 4 | environment | kubernetes: `contract` (1 driver)<br>zenith: `contract` (1 driver) |
| `drift.repair` | high | yes | — | 4 | resource | no driver |
| `function.invoke` | medium | yes | — | 4 | resource | aws: `contract` (1 driver) |
| `machine.service.restart` | medium | yes | — | 4 | resource | no driver |
| `dns.modify` | high | yes | — | 5 | resource | no driver |
| `file.upload` | high | yes | — | 5 | resource | no driver |
| `file.write` | high | yes | — | 5 | resource | no driver |
| `firewall.modify` | high | yes | — | 5 | resource | no driver |
| `infrastructure.apply` | high | yes | — | 5 | environment | no driver |
| `package.install` | high | yes | — | 5 | resource | no driver |
| `secret.write` | high | yes | — | 5 | environment | oci: `contract` (1 driver) |
| `container.exec` | critical | yes | escape hatch | 6 (never unattended) | resource | no driver |
| `database.delete` | critical | yes | destructive | 6 (never unattended) | resource | no driver |
| `database.restore` | critical | yes | destructive | 6 (never unattended) | resource | no driver |
| `identity.modify` | critical | yes | — | 6 (never unattended) | environment | no driver |
| `infrastructure.destroy` | critical | yes | destructive | 6 (never unattended) | environment | no driver |
| `machine.exec` | critical | yes | escape hatch | 6 (never unattended) | resource | no driver |
| `provider.native` | critical | yes | escape hatch | 6 (never unattended) | environment | no driver |

### Mutating capabilities by default autonomy

A mutating capability with default autonomy N needs no approval *for autonomy reasons* only in an environment whose autonomy level is at least N; every other policy rule can still require or deny ([POLICY.md](operations/POLICY.md)).

| Default autonomy | Mutating capabilities |
|---|---|
| 0 | — |
| 1 | — |
| 2 | — |
| 3 | `database.snapshot`, `service.restart`, `service.scale` |
| 4 | `database.migrate`, `deployment.deploy`, `deployment.rollback`, `drift.repair`, `function.invoke`, `machine.service.restart` |
| 5 | `dns.modify`, `file.upload`, `file.write`, `firewall.modify`, `infrastructure.apply`, `package.install`, `secret.write` |
| 6 (never unattended) | `container.exec`, `database.delete`, `database.restore`, `identity.modify`, `infrastructure.destroy`, `machine.exec`, `provider.native` |

Non-mutating capabilities are not gated by autonomy: the policy rule `autonomy_below_capability` applies to mutating capabilities only.

## Problems

None: every merged driver's declaration is consistent with its shape.
