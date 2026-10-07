# Current reduced-resource resume checkpoint: 7 October 2026

Source `80bb7352765ba83655a191b9b34d7e10827475ec`, branch `codex/production-2026-10-02`. [Sanitized bootstrap and build evidence](../evidence/PROD-CI-08/2026-10-07-mac-bootstrap-80bb7352.json) records root-executed results; this documentation update ran no services or tests. All78 criteria, ledger12 verified/38 in progress/28 planned and four false release flags remain unchanged.

## Actual results and current host state

Supabase CLI2.116.0 R13 and R15 each started five owned services and completed the genuine Auth migration helper with exit0 and confirmed removal, in30.43s and45.19s respectively. Both used Docker6GiB memory/4GiB swap. R13 actual CA-verified HTTPS reads returned200 for `/auth/v1/health` and `/rest/v1/`. These are bootstrap/health observations; no application schema, Auth users, default API/worker, signed-in browser or default-schedule acceptance cases executed.

Both later crossed the22GiB disk floor and were stopped: R13 minimum22,990,254,080bytes and R15 minimum23,038,238,720bytes, below the23,622,320,128byte floor. Successful startup did not clear the resource blocker. Owned service containers/database volumes were removed; final cleanup removed the five owned images and owned network, preserving protected baseline images without global prune. Earlier failed attempts and recoveries remain preserved privately.

The fresh native Node22.23.3 ARM64 Next standalone build on source80 exited0 in194.7s with4096MiB heap. Its standalone output survived removal of build-owned cache files. A successful build is separate from default runtime acceptance.

Docker is now configured4GiB memory/4GiB swap, Resource Saver off and VirtioFS enabled. An owned Busybox probe exited0 and reported4,012,908KiB guest memory and4,194,300KiB swap. The probe used no network and dropped all capabilities; the4GiB stack profile remains untested. Root confirmed zero containers, then stopped the idle Docker backend with exit0. Latest root free-space measurement is approximately23.1GiB; remeasure before launch.

## Current next steps

1. Recheck current Git, free disk and swap. Keep heavy work serial and the22GiB floor enforced. Existing measurements do not prove enough headroom for image pulls plus the full API/worker/browser composition.
2. Start Docker under the approved4GiB/4GiB settings. Repin actual images and create a fresh owned network with explicit loopback publications. Old frozen controllers refer to a removed network; bind a new attempt/source/config/image/network freeze and obtain independent review before any startup.
3. Preserve genuine TLS and roles. Verify the pooler TLS frontend and default database connection, then apply the canonical application/platform/agent migrations to the single genuine Supabase instance. The bare-PG CI role helper is forbidden here. Create two actual private Auth users; keep all values out of public logs.
4. Run the fresh Next standalone API and documented development SQLite Temporal/native worker profile only after those prerequisites. Label the reduced local profile and worker deviation explicitly. Execute the signed-in browser and scheduling checks separately; source-only plans and NOT_READY maintenance drafts are not runnable evidence.
5. Preserve installer separate-platform/production Temporal and hosted MCP authority blockers. No hostname aliases, fake API keys, cloud/provider calls or authority bypass. DEC-STARTUP authorizes disposable local startup only.

## Historical checkpoint: local730 and dependency/CIc9

The prior snapshot below is retained for history. Its resource settings and next-step list are superseded by the current checkpoint above; its leaf test counts retain their original source and scope.

# Resume verifier after reduced-resource acceptance attempt

Branch `codex/production-2026-10-02`. Preserve published ancestry, user files and builder wave3 ownership. Latest integrated builder parent `c9a942d664128d982415b4c8b671de88e8c3fe02`; verifier publication commit is the Git commit containing this file. Commit author and committer Arnav Bule `<arnav.bule05@gmail.com>`, no trailer/history rewrite. Before each push, `git pull --no-rebase`.

Read `HANDOFF-VERIFIER.md`, `BUILD-WAVE3-AREAS.md`, `VERIFY-QUEUE.md` and `verification/RESULTS-2026-10.md` first. All78 acceptance criteria/four false release flags retained; ledger12 verified/38 in progress/28 planned. No wave3 product source changed by verifier. Evidence below binds local730 and dependency/CIc9 separately; do not relabel it publication-source acceptance.

## Completed this attempt

Six serial leaf lanes: LIFE01 602/0/1; LIFE08 312/0/1; LIFE10 899/0/13 plus actualTemporal21/0/0; LIFE12 236/0/0; MACH05 1526/0/11 plus securitytools11/0/0, reader15/0/0 and native Darwin Go368/0/2 plus realTofu2/0/0; COST03 449/0/0. Counts overlap, never sum.250 MACH05 native SQL identities passed; eight incompatible model exclusions have actualPG counterparts. Windows-only/privateApp/kind cases remain explicitly scoped. Initial missing-role failure600/2/1 preserved; exact canonical CI role prerequisite recovered it without assertion/source edits.

Fresh install,915+6 lock integrity, complete audit0findings/noexception, compiler/lint/generated ledger passed on pulledc9. Initial heap768/1536 failures and4096 disk interruption retained; compiler4096 recovered after idle Docker backend stopped. Root inspected exactc9 CI20/20; native AMD64/ARM64 reported separately in per-job report. Inspect publication-source CI separately.

## Host and resource blocker

This8GiB Mac only; no offload for default acceptance. Docker settings6GiB memory/4GiB swap/VirtioFS/ResourceSaver off applied and actualLinux swap probed. Backend now stopped idle after all owned services settled. Supabase R4 required image pulls crossed22GiB floor before containers/tests:24.68GiB initial,21.77GiB minimum. Earlier R3 private TLS path correction independently reviewed; no guard/TLS bypass.

Later compiler swap pressure recovered, then free disk unexpectedly dropped another3GiB to~20GiB. Cleanup task found no further large safe disposable growth; attribution unresolved. Recheck current bytes, not dated figures. Do not run heavy jobs below22GiB floor. Owned downloaded images/network/leafPG/tmpfs/TLS certificates and keys removed; baseline resources preserved. No global prune or unrelated-data deletion. Private receipts/hashes survive; credentials never in public evidence.

## Next executable steps

1. Read current Git/harness state and host free disk/swap before any heavy run. Recover genuinely sufficient free space through separately authorized cleanup; measured image-pull growth >2.91GiB plus22GiB floor is only a lower bound, remaining pulls/builds unknown. No repeat unchanged cleanup loop.
2. Restart Docker only when resources fit and no unrelated containers would be disturbed. Retain approved6GiB/4GiB settings. Regenerate throwaway CA/leaf/key and private tokens; prior CA files deleted. Create a new labelled loopback-only owned network and rebind/freeze/review private CLI argv; old network/container IDs invalid.
3. Current installer requires separate platform server authority/hard-bound disposable container endpoints; native same-server/SQLite profile is not shipped installer topology proof. Have builder review supported lean default composition without weakening authority/TLS. ActualAuth/PostgREST and two private operator identities required.
4. Run steps3a–3c installation/readiness, actual signed-in UX01 accessibility at1280/375 and seven default schedules. Independently review corrected maintenance harness first; NOT_READY draft never run. Then3d–3f real registered runbook, builder-wired scoped telemetry and installed systemd agent register/revoke/rotate/signed-update/rollback. Prove private cgroup delegation/effective sandbox before Linux admission. No injected ports/mockAuth/PID1-only promotion.
5. Preserve passed730 leaf receipts where exact scope applies. Re-run affected tests only after new source/prerequisites. Final required gates and every CI job bind exact new pushed SHA; record pending/unavailable literally.

DEC-STARTUP approved local-only; DEC-CLOUD/privateApp/realDNS unapproved. Business/retention/signoff decisions remain open. Default telemetry endpoints/machine-health caller, application MFA/step-up and optimizer measurements/ownership remain builder work. No unattended background-work promise.
