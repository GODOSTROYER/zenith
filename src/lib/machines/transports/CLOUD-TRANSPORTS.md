# Cloud machine transports

Both drivers use a `CredentialBroker` callback and its existing provider session.
Targets must be present observed identities; no zone, VM name or account is inferred.
The session and transport both reject mismatched providers/accounts. All results and
errors pass through the machine service's redaction and per-request evidence path.
The default production driver table includes both transports; sandbox uses the
existing explicitly simulated drivers.

## Azure managed Run Command

`azure_run_command` accepts a full VM ARM id in the brokered subscription and
verifies `storageProfile.osDisk.osType=Linux` and the VM's own location before
dispatch. It uses API version `2025-04-01` and managed VM child resources under
`virtualMachines/{vm}/runCommands/{name}`, with `asyncExecution=true` and a bounded
`timeoutInSeconds`. Provisioning success alone never means script success: the
driver polls `$expand=instanceView` with capped exponential backoff. Response URLs,
messages and error bodies never become instructions or returned diagnostics.

The twelve semantic operations reuse the existing guarded Linux SSM document
bodies and their parameter contracts, including environment-specific file/restart
allowlists. Azure named parameters populate the script environment as `SSM_*`.
`machine.exec` uses a fixed Python collector and a protected, base64 JSON argv
parameter; Python launches argv directly, with an explicit environment. No
caller-controlled value enters script source. `container.exec` is refused; file
write/upload and package installation remain unimplemented in the machine plane.

Python 3 is required on the guest in addition to each semantic operation's tools.
Missing Python/tools produce `unavailable`. The collector drains stdout/stderr
but retains at most 2304/384 bytes and emits a complete JSON/base64 envelope below
Azure's **last 4 KiB** instance-view output limit. `file.read` is capped at 1 KiB
(further narrowed for long paths and request limits); larger reads need zenithd.
Clipped file encodings are refused, clipped lists/logs are marked truncated, and
results are decoded, redacted and byte-bounded before leaving the transport.

Command names/tags contain only a digest of the effective request and fixed source.
A preflight GET reuses an existing matching command without PUT. Resources are
retained for duplicate detection; deleting one while running cancels execution.
There is no documented atomic create-only guarantee for this PUT. The caller's
operation lease/fence remains the cross-worker race protection, as with SSM.
Expired/cancelled polling, missing/malformed results, lost PUT acknowledgments and
guest timeouts after a mutating submission yield non-retryable `uncertain`.
An explicit rejected PUT is a clean failure. No driver automatically retries PUT.
An operator who removes retained command resources also removes duplicate detection.

The Azure principal needs managed Run Command read/write and VM read permissions
even for read-only guest operations: a semantic read still deploys a managed
command resource. Execution keeps the semantic catalog's observe/deploy purpose;
configure that principal's permission boundary accordingly.

References: [managed Linux Run Command](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command-managed),
[managed create/update REST contract](https://learn.microsoft.com/en-us/rest/api/compute/virtual-machine-run-commands/create-or-update?view=rest-compute-2025-04-01).

## GCP OS management choice

`gcp_os_management` implements **only `machine.inspect`**, using read-only Compute
`instances.get`, then OS Config `inventories.get?view=BASIC` for the numeric VM id.
The target is `projects/{project}/zones/{zone}/instances/{name-or-id}`; corresponding
Compute selfLinks are normalized. The project must equal the broker session's
project. Neither metadata/startup scripts nor response URLs are used for execution.

OS policies (including `Exec` resources) reconcile desired state and can run again;
guest policies are not on-demand execution. Patch-job pre/post scripts belong to
patch orchestration and are not a safe substitute for generic machine commands.
Therefore mutations and runtime guest reads (processes, metrics, logs, files,
services, containers and network probes) are refused with an explicit reason and
directions to use zenithd. No deployment of OS/guest policies or patch job occurs.

Inventory facts are cached OS/hostname/architecture/kernel information, never live
runtime metrics. The additive `machine.inspect.data.inventory` field reports
`available | missing | inaccessible | unavailable` and `observedAt` when returned.
Inventory unavailable/not enabled/denied does not fabricate facts: the instance
can still be confirmed by Compute, with missing guest fields absent. This can be
`ok:true` with only availability metadata. Compute missing/denied is a failure.
Metadata, labels, credentials, service accounts and package lists are excluded.
The principal needs `compute.instances.get` and `osconfig.inventories.get`; VM
Manager inventory must be enabled and its guest agent reporting for guest facts.

References: [OS Inventory resource and OsInfo](https://docs.cloud.google.com/compute/docs/osconfig/rest/v1/projects.locations.instances.inventories),
[OS policy behavior](https://docs.cloud.google.com/compute/vm-manager/docs/os-policies),
[Compute instances.get](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/get).

## Verification limits

HTTP tests use fake broker sessions and provider responses. Local Python tests
exercise the actual collector and argv behavior when Python is available. No live
Azure/GCP account, VM agent parameter delivery, or real-cloud output retention has
been verified. Guest script execution needs a POSIX shell; existing shell tests
use local `sh`, with Windows WSL explicitly opt-in via `ZENITH_MACHINE_TEST_WSL=1`.
No network-dependent cloud tests run by default. Production bootstrap and cloud
identity verification are outside this workstream's owned paths.
